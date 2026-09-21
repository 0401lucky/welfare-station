package controller

import (
	"welfare/common"
	"welfare/service"

	"github.com/gin-gonic/gin"
)

// GET /api/site/info — 公开的站点信息,未登录也能读。
func (a *App) SiteInfo(c *gin.Context) {
	common.Ok(c, gin.H{
		"site_name":      a.Config.WelfareSiteName,
		"quota_per_unit": a.Config.QuotaPerUnit,
		// 只读:供前端把「单次发放上限」换算成美元提示,校验仍以后端为准。
		// 上限存配置表(后台可改),环境变量只是首次运行的种子值。
		"max_grant_quota": service.MaxGrantQuotaOf(a.DB, a.Config.MaxGrantQuota),
		"newapi_url":      a.Config.NewAPIPublicURL, // 为空时前端不渲染跳转入口
		"notice":          service.GetSiteNotice(a.DB),
	})
}
