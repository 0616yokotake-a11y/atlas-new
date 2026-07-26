# Atlas

筋トレを「続けたくなる」ためのトレーニング管理PWAです。

## 現在の実装範囲（MVP）

- ログイン / 新規登録 / パスワード再設定 / Googleログイン / 電話番号ログイン（Firebase Authentication）
- ホーム / ワークアウト / 履歴 / 分析 / 設定 タブ
- ワークアウト記録（部位・種目・重量・回数・セット編集）
- 休憩タイマー
- マイメニューの作成・編集・削除
- ローカル保存（Zustand persist）
- Firestore クラウド同期（ログイン時）
- PWAオフライン基盤（manifest + service worker）
- OpenAI API によるAI分析更新

## セットアップ

```bash
npm install
npm run dev
```

## Firebase 設定

`.env` に下記を設定してください。

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

未設定でもデモモードで画面確認は可能です（クラウド同期は無効）。

Authentication の Sign-in method で、必要に応じて以下を有効にしてください。
- Email/Password
- Google
- Phone

## 同期仕様

- Firebase設定あり + ログイン時: Firestore `users/{uid}` 配下へ同期
- デモモード: 端末ローカル保存のみ

## OpenAI 設定（Vercel / サーバー環境変数）

`OPENAI_API_KEY` を設定してください。任意で `OPENAI_MODEL` も指定できます（未指定時 `gpt-4o-mini`）。
