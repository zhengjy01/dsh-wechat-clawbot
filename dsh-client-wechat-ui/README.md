# dsh-client-wechat-ui

DSH 浏览器插件：右下角微信绿色悬浮球。

- 扫码登录面板（二维码 / 扫码状态 / 手机验证码输入）。
- ClawBot 使用模型配置：快捷选择已配密钥的模型、自定义填写、思考强度（off/high/max），保存后预选当前配置；「跟随 DSH 默认」保存即清除。
- 当前对话区显示 + 「新对话」按钮。
- 联系人白名单（批准/忽略）。
- 底部署名链接（可点击跳转）。
- 零依赖 bundle（`window.__ModuleLoader__.load` 注册，随 DSH boot 图加载），直接 fetch 本机网关/模型端点。

环境要求与安装见仓库根目录 README。
