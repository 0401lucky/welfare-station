# 留言图片存储与发布运维

## 存储与访问

留言与回复各支持最多 3 张静态 JPEG/PNG/WebP 图片,每张最多 5 MiB。后端校验真实格式、完整解码、静态帧、像素数(最多 2000 万)及单边尺寸(最多 8192);整次上传最多 16 MiB。原图保留原始字节与元数据,缩略图最长边 512 像素。原图和缩略图都必须经过留言及回复权限检查,不可配置为公开静态目录或 CDN 永久缓存。

原图、缩略图和 SQL 记录共同构成一份留言数据。图片使用应用生成的 ID,不保存上传文件名。失败或响应中断后保留草稿重试,同一次未修改的提交不会重复发布。超过 24 小时的未引用临时文件可以由应用清理;已发布或隐藏内容的图片不会自动删除,数据库查询失败时也不会执行删除。

原生启动使用 `FEEDBACK_IMAGE_DIR`(默认 `data/feedback-images`),目录应专用于本应用。已有非空目录必须带应用识别标记;无权限、无效标记或不可写会使启动失败。上传目录已排除在 Git 与 Docker 构建上下文之外,不要将其放入 `web/public`。

两份 compose 均把命名卷 `feedback-images` 挂载到 `/data/feedback-images`,并设置 `FEEDBACK_IMAGE_DIR`。镜像预先准备好归非 root 用户 `welfare` 所有的目录,空卷首次挂载时由 Docker 复制其内容与权限。普通容器重建会继续使用同一命名卷。生产文件保留 `127.0.0.1:8090:8080` 和既有 `newapi_default` 网络。

```bash
cd /opt/welfare-station
# 仅输出部署路径、镜像、图片挂载与权限,不要打印 .env 或完整容器环境。
docker inspect -f '{{.Config.Image}}' welfare-station
docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/feedback-images"}}{{.Name}} {{.Destination}}{{end}}{{end}}' welfare-station
docker exec welfare-station sh -ec 'id; test -w /data/feedback-images'
```

## 升级前备份

以下 Bash 示例适用于现有 MySQL 容器与 compose 部署。先核对 `MYSQL_CONTAINER`、`DB_NAME` 和部署路径。数据库口令只在 MySQL 容器内部读取;不要开启 `set -x`,不要将 `.env` 或备份加入 Git。备份应另行复制到受保护的异地位置。

先取一致的 SQL 快照,再备份不可变的已发布图片,这样 SQL 引用的文件都包含在文件备份内。图片备份中多出的后续文件不影响恢复。

```bash
set -euo pipefail
umask 077
cd /opt/welfare-station
MYSQL_CONTAINER=newapi9-mysql
DB_NAME=welfare_station
BACKUP_DIR="$PWD/backups/feedback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
docker inspect -f '{{.Config.Image}}' welfare-station > "$BACKUP_DIR/image.txt"
cp docker-compose.yml "$BACKUP_DIR/compose.yml"
cp .env "$BACKUP_DIR/config.env"

docker exec "$MYSQL_CONTAINER" sh -ec \
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -uroot --single-transaction --quick --routines --triggers --no-tablespaces --set-gtid-purged=OFF "$1"' \
  sh "$DB_NAME" | gzip > "$BACKUP_DIR/database.sql.gz"
gzip -t "$BACKUP_DIR/database.sql.gz"

IMAGE_VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data/feedback-images"}}{{.Name}}{{end}}{{end}}' welfare-station)
if [ -n "$IMAGE_VOLUME" ]; then
  docker run --rm \
    --mount "type=volume,source=$IMAGE_VOLUME,target=/source,readonly" \
    --mount "type=bind,source=$BACKUP_DIR,target=/backup" \
    alpine:3.19 sh -ec 'cd /source; tar -czf /backup/feedback-images.tgz .'
  chmod 600 "$BACKUP_DIR/feedback-images.tgz"
  gzip -t "$BACKUP_DIR/feedback-images.tgz"
else
  # 仅首版升级时允许没有图片卷;已有 V2 图片时必须查明挂载缺失原因。
  printf '%s\n' 'V1 deployment: no image volume' > "$BACKUP_DIR/no-images.txt"
fi
```

在发布新提交之前确认 SQL 备份非空且校验通过。推送 main 后,GitHub Actions 先执行前端与后端验证,其中 MySQL 使用独立临时数据库;通过后才构建镜像并部署。迁移为新增字段、索引和图片表,保留旧留言/回复 ID、文本和作者。不要手动删除原表、卷或图片来处理迁移错误。

## 在临时环境演练恢复

将数据库和图片恢复到**新的测试库和测试卷**,用对应 V2 镜像启动独立容器,验证原图/缩略图可读和权限一致。测试库必须与生产隔离,关闭额度自动重试,将 new-api 指向测试服务。下面的 SQL 导入只针对已创建的空测试库,不覆盖生产库。

```bash
set -euo pipefail
RESTORE_DB=feedback_v2_restore_test
RESTORE_VOLUME=feedback-v2-restore-test
# MYSQL_CONTAINER 在此必须是独立测试 MySQL;BACKUP_DIR 指向受保护备份目录。
docker exec "$MYSQL_CONTAINER" sh -ec \
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot -e "CREATE DATABASE feedback_v2_restore_test CHARACTER SET utf8mb4"'
docker volume create "$RESTORE_VOLUME"
gzip -dc "$BACKUP_DIR/database.sql.gz" | docker exec -i "$MYSQL_CONTAINER" sh -ec \
  'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -uroot "$1"' sh "$RESTORE_DB"
docker run --rm \
  --mount "type=volume,source=$RESTORE_VOLUME,target=/restore" \
  --mount "type=bind,source=$BACKUP_DIR,target=/backup,readonly" \
  alpine:3.19 sh -ec 'test -z "$(ls -A /restore)"; cd /restore; tar -xzf /backup/feedback-images.tgz'
```

恢复时保留 tar 中的文件所有者和权限,使用相同运行用户的 V2 镜像。先校验数据和图片 ID/字节,再进行实例切换。生产数据库快照恢复会丢失快照之后的新数据,需要单独明确授权并暂停写入,不属于自动部署的失败处理。

## 兼容与回滚

旧浏览器继续访问 V1 API:只把真正的站主回复作为站主回复展示,图片消息显示刷新提示。V2 API 展示成员/站主身份与完整讨论,图片与隐藏回复采用同一权限规则。

新增成员回复后,旧后端无法理解回复身份和单条隐藏语义。回滚后端必须使用兼容 V2 数据的修复镜像;不要直接把第一版镜像接到已有 V2 数据的库上。保留 SQL 与图片卷,不要使用 `docker compose down -v`,也不要将成员回复改写为站主回复。
