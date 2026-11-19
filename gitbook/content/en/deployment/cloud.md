# ☁️ Cloud Deployment

Deploy 10router on VPS or Docker for remote access and production use.

---

## 🖥️ VPS Deployment

### Prerequisites

- Ubuntu 20.04+ or similar Linux distribution
- Node.js 20+
- Git
- Root or sudo access

### Step 1: Clone Repository

```bash
git clone https://github.com/some-du6e/10router.git
cd 10router/app
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Build Application

```bash
npm run build
```

### Step 4: Configure Environment Variables

Create a `.env` file or export variables:

```bash
export INITIAL_PASSWORD="your-secure-password"
export DATA_DIR="/var/lib/10router"
export NODE_ENV="production"
```

> `JWT_SECRET` is optional. Leave it unset and 10router generates one once into `$DATA_DIR/jwt-secret`, so sessions survive restarts. Only for several instances behind one URL: generate one value once (`openssl rand -hex 32`), store it, and set that same value on every instance. Values under 32 characters or a documented placeholder are ignored.

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | Auto-generated (`$DATA_DIR/jwt-secret`) | Optional. Signs dashboard sessions. Set it only to share sessions across instances behind one URL (32+ characters; shorter values and documented placeholders are ignored) |
| `INITIAL_PASSWORD` | unset | Optional headless bootstrap password (min 8 chars). When unset, first run requires the one-time setup token printed to the server console — there is no default password |
| `DATA_DIR` | `~/.9router` | Database and data storage path (the directory name is unchanged from the previous release for backward compatibility) |
| `NODE_ENV` | `development` | Set to `production` for deployment |
| `ENABLE_REQUEST_LOGS` | `false` | Enable debug request/response logs |
| `TRUST_PROXY` | unset | `true` when a forwarder on this machine adds no forwarding header (`X-Forwarded-For`, `X-Real-IP`, …), such as socat, `ssh -R` or a TCP tunnel: its clients' own `Host` reaches 10router, so one could send `Host: localhost` and count as local. With it, no loopback connection counts as local, so tools on the server itself need an API key or the CLI token too. Or a comma list of IPs/CIDRs (`192.168.1.10,10.0.0.0/8`) for a reverse proxy on another host or container, whose forwarding headers are then read. When 10router runs in Docker behind Nginx on the host, Nginx reaches the container from the Docker bridge gateway, so list that gateway or the compose network (`172.17.0.1`, `172.18.0.0/16`); otherwise every login keys on the gateway and Nginx's headers are ignored. With it listed, `http://localhost:20128` through the published port still works with login off: it also comes from the gateway, but with no forwarding header, so it counts as a direct visit, not a proxy hop. So a listed proxy must send a forwarding header on every location: nginx drops the server-level `proxy_set_header` lines from a location that sets its own (`Upgrade`/`Connection` for WebSockets, say), and that location then looks like a direct visit |
| `ALLOWED_HOSTS` | unset | With "Require login" off, extra host names (comma list) the dashboard API answers, besides `localhost`, IP addresses, the tunnel URLs and `BASE_URL`. A loopback Host doesn't count when the request comes through a proxy hop (a loopback peer that isn't local, or one `TRUST_PROXY` lists that sent a forwarding header) |

### Step 5: Create Data Directory

```bash
sudo mkdir -p /var/lib/10router
sudo chown $USER:$USER /var/lib/10router
```

### Step 6: Start Application

```bash
npm run start
```

### Step 7: Setup PM2 for Production

PM2 keeps your application running and restarts it on crashes:

```bash
# Install PM2 globally
npm install -g pm2

# Start 10router with PM2. --kill-timeout gives requests in flight time to
# finish on `pm2 restart`/`stop`: it must be longer than SHUTDOWN_DRAIN_TIMEOUT_MS
# (3 min by default); PM2's own default is 1.6 s.
pm2 start npm --name 10router --kill-timeout 210000 -- start

# Save PM2 configuration
pm2 save

# Setup PM2 to start on system boot
pm2 startup
# Follow the instructions printed by the command above
```

**PM2 Management Commands:**

```bash
# View logs
pm2 logs 10router

# Restart application
pm2 restart 10router

# Stop application
pm2 stop 10router

# View status
pm2 status

# Monitor resources
pm2 monit
```

---

## 🐳 Docker Deployment

### Option 1: Using Dockerfile

Create a `Dockerfile` in the `app` directory:

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

**Build and Run:**

```bash
# Build image
docker build -t 10router .

# Run container
docker run -d \
  --name 10router \
  -p 3000:3000 \
  -p 20128:20128 \
  -e INITIAL_PASSWORD="your-secure-password" \
  -v 10router-data:/app/data \
  10router
```

> `JWT_SECRET` is left unset on purpose (see the note above): the secret generated in `$DATA_DIR/jwt-secret` persists across restarts.

### Option 2: Docker Compose

Create `docker-compose.yml`:

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

> `JWT_SECRET` is left unset on purpose (see the note above): the secret generated in `$DATA_DIR/jwt-secret` persists across restarts.

**Run with Docker Compose:**

```bash
# Start services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up -d --build
```

---

## 🌐 Reverse Proxy with Nginx

### Why Use Nginx?

- SSL/TLS termination
- Domain name mapping
- Load balancing
- Better security

### Step 1: Install Nginx

```bash
sudo apt update
sudo apt install nginx
```

### Step 2: Configure Nginx

Create `/etc/nginx/sites-available/10router`:

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

### Step 3: Enable Site

```bash
# Create symbolic link
sudo ln -s /etc/nginx/sites-available/10router /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### Step 4: Setup SSL with Let's Encrypt

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain SSL certificate
sudo certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
# Test renewal
sudo certbot renew --dry-run
```

---

## 🔒 Security Considerations

### 1. Secure the Dashboard Login

Set a strong `INITIAL_PASSWORD` before deployment, or leave it unset and finish first-run setup with the one-time setup token printed to the server console. There is no default password.

`JWT_SECRET` is optional: 10router generates one into `$DATA_DIR/jwt-secret` and keeps it, so keep the data directory private. Set `JWT_SECRET` only to share sessions across several instances behind one URL, using one value of 32+ characters generated once and stored:

```bash
# Run once, store the value, and set it on every instance
openssl rand -hex 32
```

### 2. Firewall Configuration

```bash
# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS (if using Nginx)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# If NOT using reverse proxy, allow 10router ports
sudo ufw allow 3000/tcp
sudo ufw allow 20128/tcp

# Enable firewall
sudo ufw enable
```

### 3. Restrict Dashboard Access

If you only need API access through Nginx, block the app's own ports from outside:

```bash
# Only allow localhost access to 10router itself
sudo ufw deny 20128/tcp
sudo ufw deny 3000/tcp
```

Reach the dashboard over an SSH tunnel to the app's port, which counts as this machine:

```bash
ssh -L 20128:localhost:20128 user@your-server.com
# Then open http://localhost:20128 in your browser
```

Requests through Nginx (or any proxy or tunnel on the server) are treated as remote: they need an API key for `/v1`, and the local-only routes (MCP servers, tunnel controls, Reset Password) and endpoints with a private URL (such as an Ollama on `localhost`) answer 403 or "URL not allowed". For those, use the SSH tunnel above (`ssh -L 20128:localhost:20128`) or the CLI on the server. Keep the `X-Real-IP` and `X-Forwarded-For` lines in the Nginx config so the login lockout counts each client separately, and keep `Host $host`, or send `X-Forwarded-Host`, so the dashboard's own API calls are accepted. Any proxy in front must overwrite or append `X-Forwarded-For` and `X-Real-IP`: one that passes the client's own values through (an Nginx block setting only `Host` and `X-Forwarded-Proto`, say) lets each client choose the keys its logins are limited on.

### 4. Regular Updates

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Update 10router
cd /path/to/10router/app
git pull
npm install
npm run build
pm2 restart 10router
```

### 5. Backup Strategy

```bash
# Backup data directory
tar -czf 10router-backup-$(date +%Y%m%d).tar.gz /var/lib/10router

# Automated daily backup (add to crontab)
0 2 * * * tar -czf /backups/10router-$(date +\%Y\%m\%d).tar.gz /var/lib/10router
```

---

## 📊 Monitoring

### Check Application Status

```bash
# PM2 status
pm2 status

# View logs
pm2 logs 10router --lines 100

# Monitor resources
pm2 monit
```

### Nginx Logs

```bash
# Access logs
sudo tail -f /var/log/nginx/access.log

# Error logs
sudo tail -f /var/log/nginx/error.log
```

### System Resources

```bash
# CPU and memory usage
htop

# Disk usage
df -h

# Network connections
netstat -tulpn | grep -E '3000|20128'
```

---

## 🚨 Troubleshooting

### Application Won't Start

```bash
# Check logs
pm2 logs 10router

# Check if ports are in use
sudo lsof -i :3000
sudo lsof -i :20128

# Check environment variables
pm2 env 10router
```

### Nginx 502 Bad Gateway

```bash
# Check if 10router is running
pm2 status

# Check Nginx error logs
sudo tail -f /var/log/nginx/error.log

# Test Nginx configuration
sudo nginx -t
```

### SSE Streaming Not Working

Ensure `proxy_buffering off` is set in Nginx configuration for SSE support.

### Permission Denied Errors

```bash
# Fix data directory permissions
sudo chown -R $USER:$USER /var/lib/10router
chmod 700 /var/lib/10router
```

---

## 🔗 Next Steps

- [Connect Providers](/providers/subscription.md)
- [Setup Combos](/features/combos.md)
- [Integrate with Tools](/integration/cursor.md)
