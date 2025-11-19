https://aaasdream.github.io/-_Token_Compress/

# C_Compress pipeline

This workspace contains an experimental Node.js utility that bundles the C-based PowerSUITE sample (`Source/`) into single text artifacts and applies lightweight token-focused compression (blank-line collapsing plus identifier shortening).

## Requirements

- Node.js 18+ (LTS) available in the shell.

## Usage

```bash
npm run compress
```

The script `tools/compress.js` will:

1. Scan every `.c`, `.h`, and `.cla` file under `Source/`。
2. Produce an unmodified concatenation (`dist/merged_raw.txt`)。
3. 依據所選策略壓縮內容（可組合）：
	- 合併 2 行以上的連續空白 (`--no-collapse` 可停用)
	- 移除多餘縮排/尾隨空白 (`--no-compact` 可停用)
	- 移除所有註解 (`--strip-comments` 啟用)
	- 縮短常見變數名稱 (`--no-variable-alias` 可停用)
	- 縮短常見函數名稱 (`--no-function-alias` 可停用)
	產出結果寫入 `dist/merged_compressed.txt`。
4. Export the applied mapping (`dist/variable_map.json`) and a summary report (`dist/report.json`)。

範例：啟用移除註解、關閉函數縮短

```powershell
npm run compress -- --strip-comments --no-function-alias
```

Compare the generated files against the current `NO_Cmpress.txt` to see whether the new heuristic reduces bytes/tokens while keeping the project in one place.

## Browser UI

- 開啟 `index.html`，依步驟選擇資料夾並產生一般合併輸出。
- 在步驟 3 的「Token 壓縮」區塊按下「執行 Token 壓縮」，瀏覽器即會套用與 Node 版本相同的策略，並可立即下載壓縮後的 TXT、識別字映射 JSON 與報告。
- 同一區塊提供「合併空白 / 縮排壓縮 / 移除註解 / 縮短變數 / 縮短函數」等切換，與 CLI 旗標對應。
