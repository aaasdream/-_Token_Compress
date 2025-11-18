#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_DIR = path.join(ROOT_DIR, "Source");
const OUTPUT_DIR = path.join(ROOT_DIR, "dist");
const RAW_OUTPUT = path.join(OUTPUT_DIR, "merged_raw.txt");
const COMPRESSED_OUTPUT = path.join(OUTPUT_DIR, "merged_compressed.txt");
const MAP_OUTPUT = path.join(OUTPUT_DIR, "variable_map.json");
const REPORT_OUTPUT = path.join(OUTPUT_DIR, "report.json");
const BASELINE_FILE = path.join(ROOT_DIR, "NO_Cmpress.txt");

const VALID_EXTENSIONS = new Set([".c", ".h", ".cla"]);
const MULTI_BLANK_LINE_REGEX = /\n{2,}/g;
const COMMENT_BLOCK_REGEX = /\/\*[\s\S]*?\*\//g;
const COMMENT_LINE_REGEX = /(^|[^:])\/\/.*$/gm;
const LINE_COMMENT_STRIP_REGEX = /\/\/[^\n]*$/gm;
const PREPROCESSOR_REGEX = /^\s*#.*$/gm;
const MIN_VARIABLE_NAME_LENGTH = 3;
const MIN_OCCURRENCE_THRESHOLD = 3;
const MIN_FUNCTION_NAME_LENGTH = 4;
const MIN_FUNCTION_OCCURRENCE_THRESHOLD = 2;
const RESERVED_IDENTIFIERS = new Set([
    "auto", "break", "case", "char", "const", "continue", "default", "do",
    "double", "else", "enum", "extern", "float", "for", "goto", "if",
    "inline", "int", "long", "register", "restrict", "return", "short",
    "signed", "sizeof", "static", "struct", "switch", "typedef", "union",
    "unsigned", "void", "volatile", "while", "_Bool", "_Complex", "_Imaginary",
    "bool", "true", "false", "size_t", "uint8_t", "uint16_t", "uint32_t",
    "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t", "float32_t",
    "float64_t", "Device_init", "Device_initGPIO", "Interrupt_initModule",
    "Interrupt_initVectorTable", "__mdebugstop"
]);
const RESERVED_FUNCTIONS = new Set([
    ...RESERVED_IDENTIFIERS,
    "main"
]);
const args = new Set(process.argv.slice(2));
const STRATEGY_FLAGS = {
    collapseBlankLines: !args.has("--no-collapse"),
    compactWhitespace: !args.has("--no-compact"),
    stripComments: args.has("--strip-comments"),
    renameVariables: !args.has("--no-variable-alias"),
    renameFunctions: !args.has("--no-function-alias")
};

async function main() {
    const files = await loadSourceFiles(SOURCE_DIR);
    if (!files.length) {
        throw new Error(`No source files with extensions ${Array.from(VALID_EXTENSIONS).join(", ")} under ${SOURCE_DIR}`);
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const rawBundle = buildRawBundle(files);
    await fs.writeFile(RAW_OUTPUT, rawBundle, "utf8");

    let processed = normalizeNewlines(rawBundle);
    if (STRATEGY_FLAGS.collapseBlankLines) {
        processed = collapseBlankLines(processed);
    }
    if (STRATEGY_FLAGS.stripComments) {
        processed = removeAllComments(processed);
    }
    if (STRATEGY_FLAGS.compactWhitespace) {
        processed = compactWhitespace(processed);
    }

    const baseExistingWords = collectExistingWords(processed);
    let variableReplacements = [];
    let variableStats = { candidateCount: 0, appliedCount: 0 };
    let usedShortNames = new Set();
    let existingWords = new Set(baseExistingWords);

    if (STRATEGY_FLAGS.renameVariables) {
        const variableResult = buildVariableReplacements(files, processed);
        variableReplacements = variableResult.replacements;
        variableStats = variableResult.stats;
        usedShortNames = variableResult.usedShortNames;
        existingWords = variableResult.existingWords;
    }

    let functionReplacements = [];
    let functionStats = { candidateCount: 0, appliedCount: 0 };
    if (STRATEGY_FLAGS.renameFunctions) {
        const functionResult = buildFunctionReplacements(files, processed, usedShortNames, existingWords);
        functionReplacements = functionResult.replacements;
        functionStats = functionResult.stats;
    }

    const allReplacements = [...variableReplacements, ...functionReplacements];
    const compressedBody = applyReplacements(processed, allReplacements);
    const mappingHeader = buildMappingHeader(variableReplacements, functionReplacements);
    const compressedOutput = `${mappingHeader}${compressedBody}`;

    await Promise.all([
        fs.writeFile(COMPRESSED_OUTPUT, compressedOutput, "utf8"),
        fs.writeFile(MAP_OUTPUT, JSON.stringify({
            variables: variableReplacements,
            functions: functionReplacements
        }, null, 2), "utf8")
    ]);

    const report = await buildReport({
        filesProcessed: files.length,
        rawBundle,
        compressedOutput,
        replacements: {
            variables: variableReplacements,
            functions: functionReplacements
        },
        stats: {
            variables: variableStats,
            functions: functionStats
        },
        strategies: STRATEGY_FLAGS
    });
    await fs.writeFile(REPORT_OUTPUT, JSON.stringify(report, null, 2), "utf8");

    emitSummary(report);
}

async function loadSourceFiles(dir) {
    const files = [];
    async function walk(current) {
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
                continue;
            }
            if (!VALID_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                continue;
            }
            const relativePath = path.relative(dir, fullPath).split(path.sep).join("/");
            const content = await fs.readFile(fullPath, "utf8");
            files.push({ relativePath, content });
        }
    }
    await walk(dir);
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
}

function buildRawBundle(files) {
    return files
        .map(file => {
            const header = `// >>> ${file.relativePath} >>>`;
            const footer = `// <<< END ${file.relativePath} <<<`;
            const body = file.content.replace(/\s+$/u, "");
            return `${header}\n${body}\n${footer}`;
        })
        .join("\n\n");
}

function normalizeNewlines(text) {
    return text.replace(/\r\n?/g, "\n");
}

function collapseBlankLines(text) {
    return text.replace(MULTI_BLANK_LINE_REGEX, "\n\n");
}

function removeAllComments(text) {
    return text
        .replace(COMMENT_BLOCK_REGEX, "\n")
        .replace(LINE_COMMENT_STRIP_REGEX, "");
}

function compactWhitespace(text) {
    const normalized = text
        .split("\n")
        .map(line => line.trimEnd().replace(/^\s+/, ""))
        .join("\n");
    return normalized.replace(/\n{2,}/g, "\n");
}

function stripCommentsAndPreprocessor(text) {
    return text
        .replace(COMMENT_BLOCK_REGEX, " ")
        .replace(COMMENT_LINE_REGEX, (match, prefix) => `${prefix} `)
        .replace(PREPROCESSOR_REGEX, " ");
}

function extractVariableNames(body) {
    const names = [];
    const sanitized = stripCommentsAndPreprocessor(body);
    const declarationRegex = /(?:^|[\s;,{}])(?!typedef)(?:const\s+|volatile\s+|static\s+|extern\s+|register\s+)*(?:struct\s+\w+\s+|enum\s+\w+\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)*[A-Za-z_]\w*(?:\s*\*+)?\s+([^;{}()"]+);/gm;

    let match;
    while ((match = declarationRegex.exec(sanitized)) !== null) {
        const declarators = match[1];
        if (!declarators) {
            continue;
        }
        declarators.split(",").forEach(chunk => {
            const cleaned = chunk
                .replace(/\[[^\]]*\]/g, " ")
                .replace(/=.*/g, " ")
                .replace(/\*/g, " ")
                .trim();
            const nameMatch = cleaned.match(/([A-Za-z_]\w*)$/);
            if (nameMatch) {
                names.push(nameMatch[1]);
            }
        });
    }
    return names;
}

function extractFunctionNames(body) {
    const names = [];
    const sanitized = stripCommentsAndPreprocessor(body);
    const attributePattern = "(?:__attribute__\\s*\\(\\([^)]*\\)\\)\\s*)?";
    const qualifierPattern = "(?:static\\s+|inline\\s+|extern\\s+|register\\s+|volatile\\s+|const\\s+|restrict\\s+|__forceinline\\s+)?";
    const returnTypePattern = "(?:[A-Za-z_][A-Za-z0-9_\s\*]*?)";
    const functionRegex = new RegExp(
        `(?:^|\\n)\\s*${attributePattern}${qualifierPattern}(?:${returnTypePattern}\\s+)+([A-Za-z_][A-Za-z0-9_]*)\\s*\\([^;{}]*\\)\\s*\\{`,
        "g"
    );
    let match;
    while ((match = functionRegex.exec(sanitized)) !== null) {
        const name = match[1];
        if (name) {
            names.push(name);
        }
    }
    return names;
}

function buildVariableReplacements(files, processedContent) {
    const counts = new Map();
    const sanitizedCorpus = files
        .map(file => stripCommentsAndPreprocessor(file.content))
        .join("\n");

    for (const file of files) {
        const candidates = extractVariableNames(file.content);
        for (const name of candidates) {
            if (!counts.has(name)) {
                counts.set(name, 0);
            }
        }
    }

    for (const name of counts.keys()) {
        const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
        const matches = sanitizedCorpus.match(regex);
        counts.set(name, matches ? matches.length : 0);
    }

    const candidates = Array.from(counts.entries())
        .filter(([name, count]) => shouldCompressName(name, count))
        .sort((a, b) => b[1] - a[1]);

    const replacements = [];
    const usedShortNames = new Set();
    const existingWords = collectExistingWords(processedContent);

    candidates.forEach(([name, count], index) => {
        const shortName = allocateShortName(index, usedShortNames, existingWords);
        replacements.push({ original: name, short: shortName, count, kind: "variable" });
        usedShortNames.add(shortName);
        existingWords.add(shortName);
    });

    return {
        replacements,
        stats: {
            candidateCount: counts.size,
            appliedCount: replacements.length
        },
        usedShortNames,
        existingWords
    };
}

function collectExistingWords(text) {
    const words = new Set();
    const regex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        words.add(match[1]);
    }
    return words;
}

function buildFunctionReplacements(files, processedContent, usedShortNames, existingWords) {
    const counts = new Map();
    const sanitizedCorpus = files
        .map(file => stripCommentsAndPreprocessor(file.content))
        .join("\n");

    for (const file of files) {
        const names = extractFunctionNames(file.content);
        for (const name of names) {
            if (!counts.has(name)) {
                counts.set(name, 0);
            }
        }
    }

    for (const name of counts.keys()) {
        const regex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
        const matches = sanitizedCorpus.match(regex);
        counts.set(name, matches ? matches.length : 0);
    }

    const candidates = Array.from(counts.entries())
        .filter(([name, count]) => shouldCompressFunctionName(name, count))
        .sort((a, b) => b[1] - a[1]);

    const replacements = [];
    const seed = usedShortNames.size;

    candidates.forEach(([name, count], index) => {
        const shortName = allocateShortName(seed + index, usedShortNames, existingWords);
        replacements.push({ original: name, short: shortName, count, kind: "function" });
        usedShortNames.add(shortName);
        existingWords.add(shortName);
    });

    return {
        replacements,
        stats: {
            candidateCount: counts.size,
            appliedCount: replacements.length
        }
    };
}

function shouldCompressName(name, count) {
    if (RESERVED_IDENTIFIERS.has(name)) {
        return false;
    }
    if (name.length < MIN_VARIABLE_NAME_LENGTH) {
        return false;
    }
    if (/^[A-Z0-9_]+$/.test(name)) {
        return false;
    }
    return count >= MIN_OCCURRENCE_THRESHOLD;
}

function shouldCompressFunctionName(name, count) {
    if (RESERVED_FUNCTIONS.has(name)) {
        return false;
    }
    if (name.length < MIN_FUNCTION_NAME_LENGTH) {
        return false;
    }
    if (/^[A-Z0-9_]+$/.test(name)) {
        return false;
    }
    return count >= MIN_FUNCTION_OCCURRENCE_THRESHOLD;
}

function allocateShortName(seedIndex, usedShortNames, existingWords) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let index = seedIndex;
    while (true) {
        let candidate = "";
        let current = index;
        do {
            candidate = alphabet[current % alphabet.length] + candidate;
            current = Math.floor(current / alphabet.length) - 1;
        } while (current >= 0);
        if (!usedShortNames.has(candidate) && !existingWords.has(candidate) && !RESERVED_IDENTIFIERS.has(candidate)) {
            return candidate;
        }
        index++;
    }
}

function applyReplacements(content, replacements) {
    let result = content;
    replacements.forEach(entry => {
        const regex = new RegExp(`\\b${escapeRegex(entry.original)}\\b`, "g");
        result = result.replace(regex, entry.short);
    });
    return result;
}

function buildMappingHeader(variableReplacements, functionReplacements) {
    const sections = [];
    const variableSection = buildMappingSection("Variable Map", variableReplacements);
    if (variableSection) {
        sections.push(variableSection);
    }
    const functionSection = buildMappingSection("Function Map", functionReplacements);
    if (functionSection) {
        sections.push(functionSection);
    }
    if (!sections.length) {
        return "/* Identifier Map: no substitutions satisfied the current heuristics */\n\n";
    }
    return sections.join("\n") + "\n\n";
}

function buildMappingSection(title, entries) {
    if (!entries.length) {
        return "";
    }
    const lines = entries
        .map(entry => `${entry.short} -> ${entry.original}`)
        .join("\n");
    return `/* ${title} (${entries.length} identifiers)\n${lines}\n*/`;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function estimateTokens(text) {
    if (!text) {
        return 0;
    }
    return Math.ceil(text.length / 4);
}

async function buildReport({ filesProcessed, rawBundle, compressedOutput, replacements, stats, strategies }) {
    const [rawBytes, compressedBytes, baselineBytes] = await Promise.all([
        byteLength(RAW_OUTPUT),
        byteLength(COMPRESSED_OUTPUT),
        fileSizeOrNull(BASELINE_FILE)
    ]);

    const rawTokens = estimateTokens(rawBundle);
    const compressedTokens = estimateTokens(compressedOutput);
    const deltaBytes = rawBytes - compressedBytes;
    const deltaTokens = rawTokens - compressedTokens;
    const variableCount = replacements.variables.length;
    const functionCount = replacements.functions.length;
    const totalReplacements = variableCount + functionCount;

    return {
        generatedAt: new Date().toISOString(),
        filesProcessed,
        rawBytes,
        compressedBytes,
        rawTokenEstimate: rawTokens,
        compressedTokenEstimate: compressedTokens,
        byteSavings: deltaBytes,
        tokenSavings: deltaTokens,
        reductionPercent: rawBytes ? Number(((deltaBytes / rawBytes) * 100).toFixed(2)) : 0,
        replacementsApplied: totalReplacements,
        variableReplacements: variableCount,
        functionReplacements: functionCount,
        candidateVariables: stats.variables.candidateCount,
        candidateFunctions: stats.functions.candidateCount,
        baselineBytes,
        strategies: {
            collapseBlankLines: Boolean(strategies?.collapseBlankLines),
            compactWhitespace: Boolean(strategies?.compactWhitespace),
            stripComments: Boolean(strategies?.stripComments),
            renameVariables: Boolean(strategies?.renameVariables),
            renameFunctions: Boolean(strategies?.renameFunctions)
        }
    };
}

async function byteLength(filePath) {
    const stat = await fs.stat(filePath);
    return stat.size;
}

async function fileSizeOrNull(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return stat.size;
    } catch (error) {
        return null;
    }
}

function emitSummary(report) {
    const lines = [
        `Files merged : ${report.filesProcessed}`,
        `Raw size     : ${report.rawBytes.toLocaleString()} bytes (~${report.rawTokenEstimate.toLocaleString()} tokens)`,
        `Compressed   : ${report.compressedBytes.toLocaleString()} bytes (~${report.compressedTokenEstimate.toLocaleString()} tokens)`,
        `Saved        : ${report.byteSavings.toLocaleString()} bytes (${report.reductionPercent}% by bytes)`
    ];
    if (typeof report.baselineBytes === "number") {
        const baselineDelta = report.baselineBytes - report.compressedBytes;
        lines.push(`Vs NO_Cmpress.txt: ${baselineDelta >= 0 ? "smaller" : "larger"} by ${Math.abs(baselineDelta).toLocaleString()} bytes`);
    }
    lines.push(`Variables mapped : ${report.variableReplacements}/${report.candidateVariables}`);
    lines.push(`Functions mapped : ${report.functionReplacements}/${report.candidateFunctions}`);
    lines.push(`Total identifiers: ${report.replacementsApplied}`);
    const strategies = report.strategies || {};
    lines.push(`collapse blanks  : ${strategies.collapseBlankLines ? "on" : "off"}`);
    lines.push(`compact spacing  : ${strategies.compactWhitespace ? "on" : "off"}`);
    lines.push(`strip comments   : ${strategies.stripComments ? "on" : "off"}`);
    lines.push(`var aliases      : ${strategies.renameVariables ? "on" : "off"}`);
    lines.push(`func aliases     : ${strategies.renameFunctions ? "on" : "off"}`);
    console.log(lines.join("\n"));
}

main().catch(error => {
    console.error("Compression pipeline failed:\n", error);
    process.exitCode = 1;
});
