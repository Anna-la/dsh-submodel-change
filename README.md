# dsh-submodel-change

DeepSeek Harness 插件:当 AI 决定调用一个 **subagent(子代理)** 时,在弹窗里由你选择
**这个子代理由哪个 provider/模型驱动**,选好后该子代理(以及它嵌套派生的子代理)
就使用你选的模型运行,不再打扰你。

- **零依赖**:不 import 任何 `@deepseek-ai/*` 包,无需构建,纯 JS (ESM)。
- **官方扩展点实现**:利用 `agent/request` waterfall 的「替换 LlmCallConfig」能力,
  这是 Harness 为拦截/改写模型路由设计的正式钩子,不 hack 任何内部实现。
- 只对 **in-process subagent** 生效(`provider: spawn`);其它 provider 的 child
  事件带不到本进程,自然跳过,不影响任何原有功能。
- 默认 **同一父会话的后续子代理复用第一次的选择**(可配置为每次都问);
  嵌套子代理自动继承父路由,不会连环弹窗。

---

## 行为预览

你在 GUI 里让 AI 做事,AI 判断需要派一个子代理时,会话里会弹出一张卡片:

> **子代理模型选择**
> 这个子代理用哪个模型运行?
> - deepseek / deepseek-chat
> - deepseek / deepseek-reasoner
> - openrouter / claude-3-5-sonnet (手动)
> - 使用默认模型(跟随父级,不修改)

选完按回车,该子代理就用所选模型执行;卡片在子代理的**第一次模型请求前**出现,
子代理会等你的选择,不会先用错模型跑起来。

---

## 安装方式 A:绝对路径直接挂载(推荐,无需任何命令)

1. 把整个 `dsh-submodel-change` 文件夹放到一个稳定的位置,例如:
   `C:\Users\Jason\Desktop\dsh-better\dsh-submodel-change\`

2. 用记事本打开 DSH Desktop 的用户补丁文件:

   ```
   %APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml
   ```

   把里面的 `[]` 替换为(路径必须写成 **file:// URL**,不能用裸 `C:/...` 盘符路径,
   Windows 下 ESM 加载器只认 `file:` 协议,否则启动会报
   `Received protocol 'c:'`):

   ```yaml
   - insert:
       - id: submodel-change
         name: 'file:///C:/Users/Jason/Desktop/dsh-better/dsh-submodel-change/index.mjs'
   ```

3. **完全重启 DSH Desktop**(关闭窗口后重新打开,不是最小化),插件即生效。
   启动日志里应出现 `[submodel-change] 已加载: 子代理发起模型请求时弹窗选择模型`。

4. 让 AI 做一件需要派子代理的事(或直接说“调用一个 subagent”),看到模型选择卡片即成功。

> 提示:如果重启后没生效,检查补丁文件是否仍是合法 YAML(缩进用两个空格)、
> 路径是否写对。

## 安装方式 B:作为 bundle 安装(需要 dsh CLI)

在 `dsh-submodel-change` 的**上一级目录**执行:

```
dsh plugin --profile web add ./dsh-submodel-change
```

然后重启 DSH Desktop。卸载:`dsh plugin --profile web remove dsh-submodel-change`。

---

## 配置项

在补丁文件的插件行下加 `config:` 即可覆盖(以下为全部默认值):

```yaml
- insert:
    - id: submodel-change
      name: 'file:///C:/Users/Jason/Desktop/dsh-better/dsh-submodel-change/index.mjs'
      config:
        enabled: true          # 总开关
        askOncePerParent: true # 同一父会话的后续子代理复用第一次的选择;
                               #   设为 false 则每个子代理都重新弹窗
        allowDefault: true     # 选项里包含「使用默认模型(跟随父级,不修改)」
        extraModels: []        # 手动追加适配器目录未列出的模型路由,
                               #   格式 ['provider/model', ...]
```

示例:每次派子代理都问、并追加一个未登记的网关模型:

```yaml
config:
  askOncePerParent: false
  extraModels: ['openrouter/deepseek-r1']
```

---

## 工作原理(简)

- **识别子代理**:child session 的 header 带 `origin: 'subagent'` 与 `parentSession`;
  只有这种 agent 的请求会被拦下,根会话自身的请求原样放行。
- **提问位置**:`agent/request` waterfall 在子代理**第一次发模型请求前**触发,监听器
  先取默认配置,再向实时根 agent(通过 `userQuestions.ask`)弹模型选择卡片——
  `ask` 严格要求 agent 是实时 root,所以提问总发生在根会话,UI 卡片也渲染在根会话。
- **注入模型**:用户选中的 `{ provider, model }` 被写回该次 `LlmCallConfig`,
  子代理随后以该路由发起请求,`request/header` 会如实记录这次路由变更。
- **复用与继承**:同一 parent 的后续子代理复用 `routeByParent` 中的选择;嵌套子代理
  由 Harness 用父路由合成子路由(`resolveChildAgentOptions`),自动继承,无需重复提问。
- **清理**:`subagent/end` / `agent/disposed` 事件按 child 释放选择与提问标记,
  避免内存泄漏。

## 目录

```
dsh-submodel-change/
├── index.mjs        # 插件本体(唯一需要挂载的文件)
├── package.json     # bundle 清单(方式 B 用)
├── cordis.patch.yml # bundle 补丁层(方式 B 用)
└── README.md
```