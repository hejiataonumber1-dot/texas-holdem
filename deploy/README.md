# 自有服务器部署网页版

更简单的 GitHub → Render 方式见根目录 README。此处用于已有 Linux 服务器和域名的情况。

需要 Docker Engine 和 Compose。域名 DNS 指向服务器，开放 TCP 80/443。具体域名与服务器的使用要求以所选服务和地区为准。

上传 Dockerfile、compose.yaml、package.json、package-lock.json、server/、web/ 和 deploy/；不上传 .env、截图或个人文件。

```sh
cp deploy/production.env.example .env.production
# 在编辑器中填写 POKER_DOMAIN、ADMIN_USERNAME 和 ADMIN_PASSWORD。
docker compose --env-file .env.production up -d --build
docker compose --env-file .env.production ps
```

打开 https://你的实际域名 即可玩。Caddy 自动提供 HTTPS 与 WebSocket 代理；应用端口 3000 不对公网开放。证书数据保存在 Docker volume 中。

打开 /admin，用上述账号密码登录并设置创建授权码，再发给允许建房的人。加入房间不需要授权码。管理员授权码记录保存在 poker_data 卷中，容器更新后保留；应定期备份该卷，避免删除卷导致记录丢失。

仅使用单实例。房间与筹码保存在内存，容器重启会清空；更新时请结束现有牌局。Docker 配置尚未运行验证，本机没有 Docker。

官方参考：[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)。
