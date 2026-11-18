# ☁️ クラウドデプロイメント

リモートアクセスと本番利用のため、VPSまたはDockerに10routerをデプロイ。

---

## 🖥️ VPSデプロイメント

### 前提条件

- Ubuntu 20.04+ または同様のLinuxディストリビューション
- Node.js 20以上
- Git
- rootまたはsudoアクセス

### ステップ1: リポジトリをクローン

```bash
git clone https://github.com/some-du6e/10router.git
cd 10router/app
```

### ステップ2: 依存関係をインストール

```bash
npm install
```

### ステップ3: アプリケーションをビルド

```bash
npm run build
```

### ステップ4: 環境変数を設定

`.env` ファイルを作成するか、変数をエクスポート:

```bash
export INITIAL_PASSWORD="your-secure-password"
export DATA_DIR="/var/lib/10router"
export NODE_ENV="production"
```

> `JWT_SECRET` は任意です。未設定のままにすると、10router が `$DATA_DIR/jwt-secret` に一度だけ生成するため、再起動してもセッションは維持されます。1つのURLの背後で複数インスタンスを動かす場合のみ: 値を一度だけ生成し (`openssl rand -hex 32`)、保存して、すべてのインスタンスに同じ値を設定してください。32文字未満の値やドキュメント記載のプレースホルダーは無視されます。

**環境変数:**

| 変数 | デフォルト | 説明 |
|----------|---------|-------------|
| `JWT_SECRET` | 自動生成 (`$DATA_DIR/jwt-secret`) | 任意。ダッシュボードのセッションに署名します。1つのURLの背後にある複数インスタンスでセッションを共有する場合のみ設定 (32文字以上。短い値やドキュメント記載のプレースホルダーは無視されます) |
| `INITIAL_PASSWORD` | 未設定 | ヘッドレス起動用のオプションパスワード(8文字以上)。未設定の場合、初回起動にはサーバーコンソールに出力されるワンタイムのセットアップトークンが必要 — デフォルトパスワードはありません |
| `DATA_DIR` | `~/.9router` | データベースとデータの保存パス （ディレクトリ名は後方互換性のため以前のリリースから変更されていません） |
| `NODE_ENV` | `development` | デプロイ時は `production` に設定 |
| `ENABLE_REQUEST_LOGS` | `false` | デバッグリクエスト/レスポンスログを有効化 |
| `TRUST_PROXY` | `false` | 同じマシン上のプロキシが `X-Forwarded-For`/`X-Real-IP` を送らず `Host` を `localhost` に書き換える場合に `true` にすると、ループバック接続をローカルとして扱わなくなります。下の Nginx 設定では不要です |

### ステップ5: データディレクトリを作成

```bash
sudo mkdir -p /var/lib/10router
sudo chown $USER:$USER /var/lib/10router
```

### ステップ6: アプリケーションを起動

```bash
npm run start
```

### ステップ7: 本番環境用にPM2をセットアップ

PM2はアプリケーションを稼働させ続け、クラッシュ時に再起動します:

```bash
# PM2をグローバルにインストール
npm install -g pm2

# PM2で10routerを起動
pm2 start npm --name 10router -- start

# PM2設定を保存
pm2 save

# システム起動時にPM2を開始するようセットアップ
pm2 startup
# 上記コマンドが出力する指示に従ってください
```

**PM2管理コマンド:**

```bash
# ログを表示
pm2 logs 10router

# アプリケーションを再起動
pm2 restart 10router

# アプリケーションを停止
pm2 stop 10router

# ステータスを表示
pm2 status

# リソースをモニタリング
pm2 monit
```

---

## 🐳 Dockerデプロイメント

### オプション1: Dockerfileを使用

`app` ディレクトリに `Dockerfile` を作成:

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Build application
RUN npm run build

# Expose ports
EXPOSE 3000 20128

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

# Create data directory
RUN mkdir -p /app/data

# Start application
CMD ["npm", "run", "start"]
```

**ビルドと実行:**

```bash
# イメージをビルド
docker build -t 10router .

# コンテナを実行
docker run -d \
  --name 10router \
  -p 3000:3000 \
  -p 20128:20128 \
  -e INITIAL_PASSWORD="your-secure-password" \
  -v 10router-data:/app/data \
  10router
```

> `JWT_SECRET` は意図的に未設定です (上記の注を参照): `$DATA_DIR/jwt-secret` に生成されたシークレットは再起動後も維持されます。

### オプション2: Docker Compose

`docker-compose.yml` を作成:

```yaml
version: '3.8'

services:
  10router:
    build: .
    container_name: 10router
    ports:
      - "3000:3000"
      - "20128:20128"
    environment:
      - NODE_ENV=production
      - INITIAL_PASSWORD=your-secure-password
      - DATA_DIR=/app/data
    volumes:
      - 10router-data:/app/data
    restart: unless-stopped

volumes:
  10router-data:
```

> `JWT_SECRET` は意図的に未設定です (上記の注を参照): `$DATA_DIR/jwt-secret` に生成されたシークレットは再起動後も維持されます。

**Docker Composeで実行:**

```bash
# サービスを起動
docker-compose up -d

# ログを表示
docker-compose logs -f

# サービスを停止
docker-compose down

# 再ビルドして再起動
docker-compose up -d --build
```

---

## 🌐 Nginxリバースプロキシ

### Nginxを使う理由

- SSL/TLS終端
- ドメイン名マッピング
- ロードバランシング
- セキュリティ強化

### ステップ1: Nginxをインストール

```bash
sudo apt update
sudo apt install nginx
```

### ステップ2: Nginxを設定

`/etc/nginx/sites-available/10router` を作成:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Redirect HTTP to HTTPS
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # SSL certificates (use certbot to generate)
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Proxy to 10router
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # SSE support - CRITICAL for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }

    # API endpoint
    location /v1 {
        proxy_pass http://localhost:20128;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # SSE support - CRITICAL for streaming
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

### ステップ3: サイトを有効化

```bash
# シンボリックリンクを作成
sudo ln -s /etc/nginx/sites-available/10router /etc/nginx/sites-enabled/

# 設定をテスト
sudo nginx -t

# Nginxをリロード
sudo systemctl reload nginx
```

### ステップ4: Let's EncryptでSSLをセットアップ

```bash
# certbotをインストール
sudo apt install certbot python3-certbot-nginx

# SSL証明書を取得
sudo certbot --nginx -d your-domain.com

# 自動更新は自動的に設定されます
# 更新をテスト
sudo certbot renew --dry-run
```

---

## 🔒 セキュリティ考慮事項

### 1. ダッシュボードのログインを保護

デプロイ前に強力な `INITIAL_PASSWORD` を設定するか、未設定のままにしてサーバーコンソールに出力されるワンタイムのセットアップトークンで初回セットアップを完了してください。デフォルトパスワードはありません。

`JWT_SECRET` は任意です: 10router が `$DATA_DIR/jwt-secret` に生成して保持するため、データディレクトリは非公開にしてください。`JWT_SECRET` は、1つのURLの背後にある複数インスタンスでセッションを共有する場合にのみ、一度だけ生成して保存した32文字以上の値で設定します:

```bash
# 一度だけ実行し、値を保存して、すべてのインスタンスに設定
openssl rand -hex 32
```

### 2. ファイアウォール設定

```bash
# SSHを許可
sudo ufw allow 22/tcp

# HTTP/HTTPSを許可 (Nginx使用時)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# リバースプロキシを使用しない場合、10routerポートを許可
sudo ufw allow 3000/tcp
sudo ufw allow 20128/tcp

# ファイアウォールを有効化
sudo ufw enable
```

### 3. ダッシュボードアクセスを制限

APIアクセスのみ必要な場合、ダッシュボードポートを制限:

```bash
# ダッシュボードへのlocalhostアクセスのみ許可
sudo ufw deny 3000/tcp
```

SSHトンネル経由でダッシュボードにアクセス:

```bash
ssh -L 3000:localhost:3000 user@your-server.com
# ブラウザで http://localhost:3000 を開く
```

Nginx(またはサーバー上の任意のプロキシやトンネル)経由のリクエストはリモートとして扱われます。`/v1` には API キーが必要で、ローカル専用ルート(MCP サーバー、トンネル操作、パスワードリセット)とプライベート URL のエンドポイント(`localhost` の Ollama など)は 403 または "URL not allowed" を返します。これらには上の SSH トンネルか、サーバー上の CLI を使ってください。ログインのロックアウトがクライアントごとに数えられるよう、Nginx 設定の `X-Real-IP` と `X-Forwarded-For` の行は残してください。ダッシュボード自身の API 呼び出しが受け付けられるよう、`Host $host` も残すか、`X-Forwarded-Host` を送ってください。

### 4. 定期的な更新

```bash
# システムパッケージを更新
sudo apt update && sudo apt upgrade -y

# 10routerを更新
cd /path/to/10router/app
git pull
npm install
npm run build
pm2 restart 10router
```

### 5. バックアップ戦略

```bash
# データディレクトリをバックアップ
tar -czf 10router-backup-$(date +%Y%m%d).tar.gz /var/lib/10router

# 自動毎日バックアップ (crontabに追加)
0 2 * * * tar -czf /backups/10router-$(date +\%Y\%m\%d).tar.gz /var/lib/10router
```

---

## 📊 モニタリング

### アプリケーションステータスを確認

```bash
# PM2ステータス
pm2 status

# ログを表示
pm2 logs 10router --lines 100

# リソースをモニタリング
pm2 monit
```

### Nginxログ

```bash
# アクセスログ
sudo tail -f /var/log/nginx/access.log

# エラーログ
sudo tail -f /var/log/nginx/error.log
```

### システムリソース

```bash
# CPUとメモリ使用量
htop

# ディスク使用量
df -h

# ネットワーク接続
netstat -tulpn | grep -E '3000|20128'
```

---

## 🚨 トラブルシューティング

### アプリケーションが起動しない

```bash
# ログを確認
pm2 logs 10router

# ポートが使用中か確認
sudo lsof -i :3000
sudo lsof -i :20128

# 環境変数を確認
pm2 env 10router
```

### Nginx 502 Bad Gateway

```bash
# 10routerが実行中か確認
pm2 status

# Nginxエラーログを確認
sudo tail -f /var/log/nginx/error.log

# Nginx設定をテスト
sudo nginx -t
```

### SSEストリーミングが動作しない

SSEサポート用にNginx設定で `proxy_buffering off` が設定されていることを確認。

### Permission Deniedエラー

```bash
# データディレクトリ権限を修正
sudo chown -R $USER:$USER /var/lib/10router
chmod 700 /var/lib/10router
```

---

## 🔗 次のステップ

- [プロバイダーを接続](/providers/subscription.md)
- [コンボをセットアップ](/features/combos.md)
- [ツールと統合](/integration/cursor.md)
