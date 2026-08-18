package common

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Unified API response envelope: {"success": bool, "message": string, "data": any}
// Aligned with the new-api response contract in design.md §4.

func Ok(c *gin.Context, data any) {
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    data,
	})
}

func OkMsg(c *gin.Context, msg string, data any) {
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": msg,
		"data":    data,
	})
}

func Fail(c *gin.Context, code int, msg string) {
	c.JSON(code, gin.H{
		"success": false,
		"message": msg,
		"data":    nil,
	})
}

func FailData(c *gin.Context, code int, msg string, data any) {
	c.JSON(code, gin.H{
		"success": false,
		"message": msg,
		"data":    data,
	})
}

func BadRequest(c *gin.Context, msg string) {
	Fail(c, http.StatusBadRequest, msg)
}

func Unauthorized(c *gin.Context, msg string) {
	Fail(c, http.StatusUnauthorized, msg)
}

func Forbidden(c *gin.Context, msg string) {
	Fail(c, http.StatusForbidden, msg)
}

func InternalError(c *gin.Context, msg string) {
	Fail(c, http.StatusInternalServerError, msg)
}
