# StudyNotes

とてもシンプル。でも学習に必要な機能はすべて入った、Windows 用のノートアプリです。

- ノートは普通の **.md ファイル**（メモ帳や Obsidian でも開けます）
- **書いたまま整形表示**（カーソルのある行だけ記号が見える）。画像も本文中に表示、書式は下のツールバーからも付けられる
- `[[ノート名]]` で**ノート同士をリンク**（`[[` で候補表示、名前を変えるとリンクも自動で更新）
- **2つのノートを左右に並べて表示**（Ctrl+クリックで反対側に開く）
- **暗記モード**：`==キーワード==` や `{{穴埋め}}` を塗りつぶし、クリックで1つずつ表示
- **フォルダ構造のエクスプローラー**、Ctrl+P のノート検索、全文検索、ピン留め
- **画像の貼り付け**（attachments フォルダに保存。同じ名前でも上書きしない）
- **AIチェック**：誤字・表記ゆれ・内容の誤りを指摘（OpenAI / DeepSeek / Gemini / Claude / OpenAI互換）
- **AIチャット**：ノートを参照しながら質問。要約・確認問題づくりもワンタッチ、回答はノートに挿入できる

詳しい仕様は [docs/SPEC.md](docs/SPEC.md) を見てください。

## インストール

1. [Releases](https://github.com/nagamine-rgb/studynotes/releases/latest) の **Assets** から `StudyNotes_x.y.z_x64-setup.exe` をダウンロード
2. ダウンロードしたファイルを実行（新しい版も同じ手順で上書きインストールできます。ノートは消えません）
3. 初回起動時にノートを保存するフォルダを選ぶ

> 署名のないアプリのため、初回は Windows SmartScreen の警告が出ることがあります。「詳細情報」→「実行」で起動できます。

## AIチェックの準備

⚙ 設定 → AIチェック で

1. サービスを選ぶ
2. API キーを貼り付けて［保存］（Windows の資格情報マネージャーに保存され、ファイルには残りません）
3. ［一覧を更新］で、そのサービスで今使えるモデルを取得し、プルダウンから選ぶ

## よく使うショートカット

| 操作 | キー |
| --- | --- |
| ノート名でジャンプ | Ctrl+P |
| 全文検索 | Ctrl+Shift+F |
| 暗記モード | Ctrl+M（Space で次を表示） |
| 選択をキーワード化（`==` の付け外し） | Ctrl+H |
| 1画面 ⇔ 2画面 | Ctrl+\ |
| 太字／斜体／リンク | Ctrl+B ／ Ctrl+I ／ Ctrl+K |
| AIパネル | Ctrl+Shift+A |

## 開発

必要なもの：Node.js 22、Rust（stable）、Windows では WebView2（Windows 10/11 には標準で入っています）

```sh
npm install
npm run tauri dev      # 開発用に起動
npm test               # 画面側のテスト
cd src-tauri && cargo test   # Rust 側のテスト
npm run tauri build    # インストーラーを作成（Windows 上で実行）
```

### リリースの手順

1. `package.json`・`src-tauri/Cargo.toml`・`src-tauri/tauri.conf.json` の版番号を上げる
2. `docs/releases/v<版番号>.md` に変更点を書く
3. main に push → GitHub Actions がビルドし、その版のリリースがまだなければ、タグ `v<版番号>` を付けて Releases に自動で公開する

構成：Tauri 2（Rust）＋ TypeScript ＋ Vite、エディタは CodeMirror 6、表示は markdown-it。
