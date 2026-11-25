# 画镜 AI × AIAPIO 服务商插件

使用自己的 AIAPIO API Key，在画镜 AI 桌面端的画布生成图片和视频。Windows 和 macOS 共用同一个插件 ZIP。已在两端的画镜 AI 4.5.7 完成真实生成和回传验证。

## 下载与安装

**第一次用 API Key？** [打开新手图文教程](app/docs/guide.md)，跟着截图完成下载、配置、出图和出视频。

1. 到 [GitHub 发行版](https://github.com/simonsxxs/huajing-ai-aiapio-provider/releases/tag/v0.1.0) 或 [Gitee 发行版](https://gitee.com/simonsxx/huajing-ai-aiapio-provider/releases/tag/v0.1.0) 下载附件 `aiapio-provider-0.1.0.zip`。
2. 在画镜 AI 打开「系统设置 → 插件 → 导入插件」，选择下载的 ZIP。
3. 在「AIAPIO · 沙鸥 AI」卡片填写自己的 AIAPIO API Key，保存设置。填写后，AIAPIO 模型会出现在画布图片和视频节点的模型菜单中。
4. 选择模型、填写提示词并生成，在原节点查看图片或播放视频。生成费用由自己的 AIAPIO 账户结算。

首版声明 31 个图片模型和 42 个视频模型。真实验收覆盖 GT Image 2.6 Flare 文生图（1K、1:1）及 GK Imagine 1.5 文生视频（480p、4 秒），各在 Windows 和 macOS 独立生成一次。其余模型完成了模拟测试，实际可用性取决于账户权限和模型渠道。

插件 ZIP 的 SHA-256 为 `bb8a23ecf902ff4a9a328a86ee033d2a9ff4c275622642d65780b7872295b9c1`。

[安装与排错指南](app/docs/安装与使用.md) · [AIAPIO API 文档](https://aiapio.com/zh-CN/api-docs)

## 从源码构建

构建需要 Python 3.9 或更新版本。测试需要 Node.js 18 或更新版本及 `unzip`。直接在画镜导入插件 ZIP 时，由画镜提供运行环境。

```sh
python3 app/plugin/build.py
node --test app/plugin/handler.test.mjs
```

输出位于 `app/dist/aiapio-provider-0.1.0.zip`。测试使用模拟响应，无需 API Key。

源码采用 [MIT 许可证](LICENSE)。画镜 AI 桌面客户端由其开发方提供。

## 作者

- **作者**：simon，一个不懂代码的AI极客
- **微信交流群**：simonsxxs
- **个人网站**：https://simonsxx.com
- **AI 聚合平台**：https://aiapio.com
- **GitHub**：https://github.com/simonsxxs
- **Gitee**：https://gitee.com/simonsxx
