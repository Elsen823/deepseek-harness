# Agent Note: 源站内容编码、哈希资产缓存与仅回环 source map

Status: implemented

[English](2026-08-21-web-origin-encoding-and-cache.md) | 中文

## Problem

Web GUI 源站是明文 `node:http` 服务器。dist 文件和 `/plugins/<id>/client.js` 以未压缩、无校验器的方式发送，插件 bundle 即使 URL 已带内容 `rev` 仍携带 `Cache-Control: no-cache`。因此组合后的页面每次访问都要传输数兆字节 JavaScript，打开 DevTools 还可能再拉一层 `.map`。高 RTT 叠加网络（包括 Tailscale）会把代价乘上请求次数；用 Netty 式 NIO 替换 Node 本已非阻塞的 socket，并不会减少字节、往返或解析时间。

HTTP/2 不是该源站的产品不变量（[WebSocket 下行载体](2026-08-04-websocket-downlink-carrier.zh.md)）。部署可以在 `127.0.0.1` 前面终止 TLS 并做多路复用；源站仍然必须发出那些跳可以转发的可压缩表示和缓存头。

## Decision

`dsh-host-webserver` 导出 `writeHttpBody` 和 `isDirectLoopback`。`dsh-host-frontend-static` 的资产路由以及 client-modules 的插件 bundle 处理器使用它们：

- 当 `Accept-Encoding` 请求且媒体类型为文本类时，使用 gzip 或 Brotli。通常策略会跳过小于 256 字节的正文或大于 identity 的编码表示；显式较低质量或被禁用的 identity 会覆盖这两项尺寸优化。每个经过协商的响应都携带 `Vary: Accept-Encoding`，包括二进制 identity 与 406 响应。
- 归一化后仍位于 `/assets/` 且文件名具有哈希形态的目标，以及 `rev` 同时精确匹配当前图行与刚读出字节的 `/plugins/<id>/client.js?rev=…`，发送 `Cache-Control: public, max-age=31536000, immutable`。过期或畸形的插件 revision 返回 404。`index.html`（启动 manifest 注入）和其他未哈希文件发送 `no-cache` 加上 ETag，匹配的 `If-None-Match` 返回 304。HMR（热模块替换）仍然有效，因为内容变化会得到新的 `rev` 或 Vite 哈希以及新 URL。
- Source map（`.map` 路由和尾部 `sourceMappingURL` 注释）只给直连回环客户端：TCP 对端为回环、`Host` 为回环名，且没有 `Forwarded`、`Via`、`X-Forwarded-*` 或 `X-Real-Ip`。绑定在 127.0.0.1 上的反向代理（包括 Tailscale Serve）通不过该检查，因此远程 DevTools 会话不会拉取 map。

绘制屏障是 `partitionBootRoster` 中的 chrome 名册，不是整张图（[客户端插件加载](2026-07-23-client-plugin-loading-model.zh.md)）。

## Alternatives considered

**用 Netty 式 NIO 或额外网关进程替换 `node:http`。** Node 已经使用 libuv 非阻塞 I/O。额外一跳不会缩小载荷或 HTML 驱动的请求瀑布，因此被否决为 Page Load 杠杆。

**把 HTTP/2 做成源站的产品依赖。** 浏览器不讲 h2c；TLS 和证书会变成源站职责。需要多路复用的部署在前面放 TLS 终结器。即便如此，明文 `:port` 客户端仍能通过 gzip 和缓存受益。

**对每个插件 bundle 保留 `no-cache`，以便刷新总是打到磁盘。** `rev` 查询已经是缓存破坏器（[客户端插件加载](2026-07-23-client-plugin-loading-model.zh.md)）。对 `rev` URL 做不可变缓存不会掩盖重建；新的图行就是新 URL。Index HTML 继续再验证，因为它携带实时图。

**向每个客户端提供 source map，指望 DevTools 不去请求。** 只要 DevTools 打开，Chromium 就会拉取 `sourceMappingURL`。map 比它们描述的脚本更大；它们不是会话有用功。回环保留本地调试。

**在构建期预压缩 `.gz`/`.br`。** 单用户源站用即时 zlib 即可，无需额外产物。若源站 CPU 成为瓶颈，预压缩仍然可用。

**把每个 graph row 留在绘制屏障上。** settings 和第三方 bundle 就会留在关键路径上。chrome-first mount 是已交付的绘制屏障；本注记只拥有字节和缓存，不拥有那份名册。

## Consequences

高 RTT 路径上的回访可以复用带哈希的脚本；冷访问仍传输 gzip/Brotli 而不是原始源码，并且 chrome 可以在延迟的 graph row 完成之前绘制。远程性能剖析不再包含 map。缓冲完整正文的路由所有者应调用 `writeHttpBody`，不要复制编码。流式响应（SSE、WebSocket）不在范围内，不得包装。若反向代理剥掉转发头并把 `Host` 改写成 `127.0.0.1`，会被当成回环；Serve 和 Caddy 不会这样做。
