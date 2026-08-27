# dsh-turn-notify

DeepSeek Harness 插件:当 agent 完成一轮操作(你可以继续输入指令的那一刻),
通过 **Windows 自带的通知中心** 弹出系统通知,内容形如:

> **DeepSeek Harness**
> 「写周报」第 3 轮操作已完成

- **零依赖**:不 import 任何 `@deepseek-ai/*` 包,无需构建,纯 JS (ESM)。
- **全部结束原因都会通知**(可配置):正常完成 / 出错 / 被阻止 / 达 Token 上限 / 中止 / 中断,文案各不相同。
- 只通知**根会话**(你直接对话的那个);子 agent / fork 出来的会话结束不会打扰你。
- 标识取**会话标题**(自动跟踪 `session/title`),取不到时回退为「Agent」。

---

## 安装方式 A:绝对路径直接挂载(推荐,无需任何命令)

1. 把整个 `dsh-turn-notify` 文件夹放到一个稳定的位置,例如:
   `C:\Users\Jason\Desktop\dsh-message\dsh-turn-notify\`

2. 用记事本打开 DSH Desktop 的用户补丁文件:

   ```
   %APPDATA%\dsh-desktop\harness\profiles\web\cordis.patch.yml
   ```

   把里面的 `[]` 替换为(路径必须用**正斜杠**的绝对路径):

   ```yaml
   - insert:
       - id: turn-notify
         name: 'C:/Users/Jason/Desktop/dsh-message/dsh-turn-notify/index.mjs'
   ```

3. **完全重启 DSH Desktop**(关闭窗口后重新打开,不是最小化),插件即生效。
   启动日志里应出现 `[turn-notify] 已加载, ...`。

4. 随便让 agent 跑一轮,结束后通知中心就会弹出通知。

> 提示:如果重启后没生效,检查补丁文件是否仍是合法 YAML(缩进用两个空格),
> 路径是否写对;Windows 通知中心若没弹,先检查系统「通知」设置里
> PowerShell / 该应用的通知是否被关闭。

## 安装方式 B:作为 bundle 安装(需要 dsh CLI)

在 `dsh-turn-notify` 的**上一级目录**执行:

```
dsh plugin --profile web add ./dsh-turn-notify
```

然后重启 DSH Desktop。卸载:`dsh plugin --profile web remove dsh-turn-notify`。

---

## 配置项

在补丁文件的插件行下加 `config:` 即可覆盖(以下为全部默认值):

```yaml
- insert:
    - id: turn-notify
      name: 'C:/Users/Jason/Desktop/dsh-message/dsh-turn-notify/index.mjs'
      config:
        enabled: true          # 总开关
        appName: 'DeepSeek Harness'   # 通知标题
        fallbackAgent: 'Agent'        # 取不到会话标题时正文里的名字
        notifyKinds: []        # 只通知这些结束原因;空数组 = 全部
                               #   可选: completed / error / blocked /
                               #         max-tokens / aborted / interrupted
        cooldownMs: 2000       # 同一会话两次通知的最小间隔(毫秒)
        silent: false          # true 时不播放通知声音
```

示例:只想在「正常完成」和「出错」时通知、且不响铃:

```yaml
config:
  notifyKinds: ['completed', 'error']
  silent: true
```

---

## 手动验证通知通道

不装插件也能先验证 Windows 通知通道是否可用,双击运行:

```
dsh-turn-notify\test-toast.ps1
```

应弹出「DeepSeek Harness — 测试通知」;弹不出来说明系统通知设置或 PowerShell
运行策略有问题,需要先解决再谈插件。

---

## 工作原理(简)

- 监听 Cordis 事件 `session/event`(`{ global: true }` 收所有会话),过滤持久事件 `turn/end`。
- `turn/end` 的数据 `{ turn, reason }` 正是「agent 完成这一轮操作、用户可以继续输入」的时刻;
  `reason.kind` 决定文案:completed / error / blocked / max-tokens / aborted / interrupted。
- 通过 `session/title` 事件跟踪每个会话的标题作为标识。
- 通知实现:`powershell.exe -EncodedCommand`(UTF-16LE Base64)调用 WinRT
  `ToastNotification`,走系统通知中心,零模块依赖,避免编码/引号问题。

## 目录

```
dsh-turn-notify/
├── index.mjs        # 插件本体(唯一需要挂载的文件)
├── package.json     # bundle 清单(方式 B 用)
├── cordis.patch.yml # bundle 补丁层(方式 B 用)
├── test-toast.ps1   # 手动验证通知通道的脚本
└── README.md
```
