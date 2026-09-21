package middleware

import "github.com/gin-gonic/gin"

// cspReportOnly 先以 Report-Only 模式下发,只上报不拦截:Tailwind 与 framer-motion
// 依赖内联样式,头像来自 LinuxDO CDN(域名不固定,故 img-src 放宽到 https:),
// 字体走 Google Fonts(样式表在 googleapis、字体文件在 gstatic),西瓜等小游戏以
// 同源 iframe 加载,frame-ancestors 必须允许 'self'。
// 已知会上报的一处:web/public/assets/games/watermelon/index.html 里有一段内联
// <script>,切强制模式前需外置成文件或补 hash。观察一段时间没有其它误报后再切换。
const cspReportOnly = "default-src 'self'; img-src 'self' data: https:; " +
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'; " +
	"connect-src 'self'; font-src 'self' data: https://fonts.gstatic.com; frame-ancestors 'self'"

// SecurityHeaders 给所有响应加固定安全头。
//
// httpsMode 由 WELFARE_BASE_URL 是否为 https 决定(与 Cookie Secure 同源判断):
// 只有确认走 HTTPS 时才下发 HSTS,否则本地 http 开发会被浏览器缓存的 HSTS 卡住。
//
// X-Frame-Options 用 SAMEORIGIN 而不是 DENY:站内小游戏是同源 iframe,DENY 会把
// 自己的游戏页一并拦掉;SAMEORIGIN 同样能挡住第三方站点的点击劫持。
func SecurityHeaders(httpsMode bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		h.Set("Content-Security-Policy-Report-Only", cspReportOnly)
		if httpsMode {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}
