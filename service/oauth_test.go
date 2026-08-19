package service

import "testing"

// TestNormalizeAvatarURL 覆盖 LinuxDO 头像字段的四种形态:
// 直接给绝对地址、只给相对 template、给绝对 template、两者都缺。
func TestNormalizeAvatarURL(t *testing.T) {
	cases := []struct {
		name string
		user OAuthUser
		want string
	}{
		{
			name: "avatar_url 优先直接使用",
			user: OAuthUser{
				AvatarURL:      "https://cdn.linux.do/avatar/123.png",
				AvatarTemplate: "/user_avatar/linux.do/alice/{size}/123_2.png",
			},
			want: "https://cdn.linux.do/avatar/123.png",
		},
		{
			name: "相对 template 换 size 并补站点前缀",
			user: OAuthUser{AvatarTemplate: "/user_avatar/linux.do/alice/{size}/123_2.png"},
			want: "https://linux.do/user_avatar/linux.do/alice/144/123_2.png",
		},
		{
			name: "绝对 template 只换 size",
			user: OAuthUser{AvatarTemplate: "https://cdn.linux.do/user_avatar/{size}/123_2.png"},
			want: "https://cdn.linux.do/user_avatar/144/123_2.png",
		},
		{
			name: "两个字段都没有则为空串",
			user: OAuthUser{},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeAvatarURL(&tc.user); got != tc.want {
				t.Fatalf("NormalizeAvatarURL() = %q, want %q", got, tc.want)
			}
		})
	}
}
