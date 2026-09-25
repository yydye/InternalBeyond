# P32-W.2 · Windows Installer Authority Convergence

审计日期：2026-09-21  
审计范围：Windows installer、Tauri NSIS、release/update chain、launcher、runtime、registry、installed filesystem。  
本报告本身是本轮唯一新增文件；没有执行构建、安装、卸载、注册表写入、版本修改、installer 删除或 commit。

## Stop condition

本轮触发 Stop Condition #4：

> 现有 install/uninstall smoke 虽然隔离了安装目录、端口和 LOCALAPPDATA，但没有隔离生产 Inno AppId 对应的 HKCU 卸载注册表键。

证据链：

- 生产 Inno 身份是 installer/InternalBeyond.iss:44-63 的 AppId {78B427F6-A48F-4443-86D5-2F50DC899D07}。
- smoke 固定查询同一个生产键：tests/test_installer_smoke.js:75-80。
- smoke 的安装仍直接运行被测 installer，并把 /DIR 指向临时目录：tests/test_installer_smoke.js:383-389。
- smoke 随后直接运行该临时目录下的 uninstaller：tests/test_installer_smoke.js:391-394。
- 当前生产键已经登记真实 E2E 安装 [local path redacted] D 节。

因此不能运行 --install-audit 或 --real-install-smoke，也不能用生产 AppId 编译一个临时安装器来规避问题。否则临时测试安装会覆盖真实生产卸载项，测试卸载还可能删除该卸载注册。安装/升级/卸载测试均标记为未执行；本报告不宣布 Closure Gate 通过。

## A. Existing Release Authority

### 事实

| 项目 | 证据 / 结论 |
|---|---|
| Installer technology | Inno Setup 6；installer/InternalBeyond.iss:1-17 |
| Canonical installer source | installer/InternalBeyond.iss |
| Canonical build command | powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1；installer/InternalBeyond.iss:6-7 |
| Canonical output | dist\InternalBeyond-Setup-<version>.exe、SHA256SUMS.txt、update-stable.json；scripts/build-installer.ps1:7-29,337-429 |
| Version source | root VERSION，当前 1.0.6；runtime/product-version.js:4-21,27-32,51-82 |
| Product identity | Inno AppId {78B427F6-A48F-4443-86D5-2F50DC899D07}；installer/InternalBeyond.iss:44-58 |
| Install scope | per-user、PrivilegesRequired=lowest、不允许 all-users override；installer/InternalBeyond.iss:60-65 |
| Default install path | %LOCALAPPDATA%\Programs\InternalBeyond；installer/InternalBeyond.iss:63 |
| Architecture | x64-compatible；installer/InternalBeyond.iss:79-82 |
| Payload authority | whitelist staging，不直接打包 repository；scripts/release-manifest.js:6-22,32-96，scripts/build-installer.ps1:264-310 |
| Launcher | 启动 InternalBeyond.vbs → bundled Node → runtime/launch-internal-beyond.js；VBS 的解析、预检和隐藏启动见 启动 InternalBeyond.vbs:21-29,42-83,140-149 |
| Service behavior | 不安装 Windows service；launcher/runner 在用户目录运行既有 Bridge、Active、Home Node 和静态服务；installer/InternalBeyond.iss:9-17、runtime/launch-internal-beyond.js:3-24 |
| Upgrade behavior | 安装前用 ib-stop.js 和共享 lifecycle 停止自己的组件；升级后按 previous manifest 与 new manifest 的差集清理 stale payload；installer/InternalBeyond.iss:144-147,346-395 |
| Uninstall behavior | Inno unins000.exe；先运行 ib-stop.js，不使用 [UninstallDelete]，保留用户数据；installer/InternalBeyond.iss:144-147,397-406 |
| Update behavior | 客户端下载并校验 InternalBeyond-Setup-<version>.exe，把 payload 放到 %LOCALAPPDATA%\InternalBeyond\updates，再 detached 启动 Inno installer；runtime/update-manifest.js:42-59,267-275、runtime/update-install.js:9-18,41-45,64-68,602-623 |
| WebView2 | 原 Inno source 没有 WebView2 检测、下载或安装逻辑；对 installer/InternalBeyond.iss 的 targeted search 无匹配 |

### 当前实际文件清单

node scripts/release-manifest.js 的只读 resolve 结果：

~~~text
ok=true
entries=39
files=348
totalBytes=129270083
missing=[]
denied=[]
~~~

清单包含 Web Core、runtime、bundled Node、VBS、Bridge、Active、Home Node、tools/ib-stop.js、文档和许可证；它排除 logs、browser-data、tests、scripts、installer source、bg-canvas.png 等开发/用户内容。

## B. Tauri NSIS Authority

### Source/config authority

- productName=InternalBeyond、identifier=com.internalbeyond.desktop、frontendDist=../.tauri-frontend：src-tauri/tauri.conf.json:3-9。
- NSIS target、current-user install、Start Menu folder、WebView2 download bootstrapper：src-tauri/tauri.conf.json:28-57。
- Cargo package mirror version 1.0.6：src-tauri/Cargo.toml:1-4。
- build.rs 读取 root VERSION 并拒绝 VERSION != CARGO_PKG_VERSION：src-tauri/build.rs:74-96。

### Generated NSIS behavior

审计对象是生成文件 src-tauri/target/release/nsis/x64/installer.nsi，不是新的 source authority：

- PRODUCTNAME=InternalBeyond、VERSION=1.0.6、INSTALLMODE=currentUser、MAINBINARYNAME=internalbeyond-host、BUNDLEID=com.internalbeyond.desktop：installer.nsi:34-65。
- uninstall key 是 Software\Microsoft\Windows\CurrentVersion\Uninstall\InternalBeyond，manufacturer product key 是 Software\InternalBeyond\InternalBeyond：installer.nsi:60-62。
- 默认路径是 %LOCALAPPDATA%\InternalBeyond：installer.nsi:489-507。
- 同版本/版本比较读取的是自己的 UNINSTKEY：installer.nsi:211-230。
- downgrade 被允许：installer.nsi:53。
- 重新安装时从自己的 manufacturer product key 读取旧路径并写回 $INSTDIR：installer.nsi:2005-2009。
- 只复制 host exe 和 Tauri resource tree 到 $INSTDIR / $INSTDIR\_up_：installer.nsi:628-685。
- WebView2 使用 Evergreen bootstrapper，检测 HKLM/HKCU EdgeUpdate key，缺失时下载 go.microsoft.com/fwlink/p/?LinkId=2124703：installer.nsi:536-626。
- registry 写入、DisplayVersion、InstallLocation、UninstallString：installer.nsi:1225-1260。
- Start Menu/Desktop shortcut 都指向 internalbeyond-host.exe：installer.nsi:2022-2085。
- uninstall 只检查/删除主 host 和它枚举的 _up_ resource files：installer.nsi:1323-1335 及后续 generated delete list；没有调用 tools/ib-stop.js。
- optional “delete app data” 删除的是 com.internalbeyond.desktop storage，不是 %LOCALAPPDATA%\InternalBeyond：installer.nsi:1976-1992。

### Resource shape

只读枚举当前生成的 Tauri _up_：

~~~text
535 files
140,226,038 bytes
包含：InternalBeyond.html、assets、apps、game、docs、runtime、services、bridge、active、bundled node
不包含：启动 InternalBeyond.vbs、tools/ib-stop.js、LICENSES
包含：bg-canvas.png
~~~

这与 Inno whitelist 的文件 ownership 不相同。Tauri _up_ 是 acceptance bundle 的真实 resource tree，不应直接当作 canonical Inno payload。

## C. Collision Analysis

结论分类：**B — 同一个产品的不同 installer identity**。

不是 A：两者的卸载键不同，Inno 使用 {GUID}_is1，Tauri NSIS 使用 Uninstall\InternalBeyond。  
不是 C：两者的产品名、publisher、Web Core、runtime 和服务拓扑都指向同一个 InternalBeyond。  
不是 D：registry、generated NSIS 和 Inno source 都给出了足够证据。

### 为什么 P32-W.1 复用了 [local path redacted]

这是 Tauri 自己的 previous-install-location 机制，不是 Windows 把 Inno AppId 识别成了 Tauri identity：

1. 当前 Tauri registry key HKCU\Software\InternalBeyond\InternalBeyond 的 (Default) 是 [local path redacted]
2. 该 key 与 Installer Language 由 Tauri generated NSIS 的 manufacturer product key 管理。
3. generated NSIS 定义 MANUPRODUCTKEY=Software\InternalBeyond\InternalBeyond：installer.nsi:60-62。
4. RestorePreviousInstallLocation 读取这个 key 的 default value 并覆盖 $INSTDIR：installer.nsi:2005-2009。

所以 P32-W.1 的复用原因可确定为：

~~~text
Tauri previous-install key
    HKCU\Software\InternalBeyond\InternalBeyond
        (Default) = [local path redacted]
        ↓
Tauri NSIS RestorePreviousInstallLocation
        ↓
$INSTDIR = [local path redacted]
~~~

Inno 的 {78B427F6-...}_is1 仍然指向另一棵 [local path redacted] 没有读取该 GUID key。

### 静态 uninstall collision simulation（未执行）

#### Existing Inno → same directory → Tauri NSIS → Existing Inno uninstall

1. Tauri NSIS 不会把 Inno 的 {GUID}_is1 当作自己的 existing install，因为它只读取自己的 UNINSTKEY 和 MANUPRODUCTKEY。
2. 如果用户显式把 Tauri 安装到 Inno root，Tauri 会向同一棵树写入 internalbeyond-host.exe、_up_、uninstall.exe 和自己的 registry/shortcut metadata；Inno 的 VBS、sidecars 和 root payload 不属于 Tauri 的完整 ownership list。
3. Existing Inno uninstaller 只按自己的 install log 删除 Inno 记录的 payload，并移除 Inno registry key；Tauri host、_up_ 或 Tauri uninstaller 可能被留下。因为两边还共享可见的 InternalBeyond.lnk 名称，shortcut 也可能被其中一方覆盖或删除。
4. 结果不是安全的“升级”，而是两个 file owner 和两个 uninstaller 对同一目录的部分 ownership。

#### Tauri NSIS → same directory → Existing Inno upgrade

1. Inno 的 AppId 不匹配 Tauri 的 Uninstall\InternalBeyond，所以 Inno 不会把 Tauri install 当成自己的 previous install；没有显式 /DIR 时还会采用自己的 %LOCALAPPDATA%\Programs\InternalBeyond default path。
2. 如果用户显式指定相同 root，Inno 会按自己的 payload manifest/whitelist 写入 VBS、runtime、services 和 Web Core，并留下 Tauri 的 internalbeyond-host.exe、_up_、uninstall.exe 等非-Inno-owned files。
3. Inno 的 upgrade stop surface 只保证它能证明属于该 root 的 Node/sidecar；generated Tauri host 没有被 Existing Inno 的当前 stop helper 纳入 ownership。若 host 正在运行，当前 canonical Inno upgrade 的 host-lock 行为尚未验证。
4. Tauri 的 registry entry 和 Inno 的 GUID entry 可能同时存在，Start Menu/Desktop 仍会竞争同一个可见产品名。

#### Tauri NSIS uninstall in a shared directory

1. generated NSIS 只以自己的 internalbeyond-host.exe 和 _up_ resource list 为主要删除对象：installer.nsi:1323-1335 及 generated delete list。
2. 它没有调用 Existing Inno 的 ib-stop.js，所以不能证明 Bridge、Active、Home Node 或静态服务已停。
3. 默认不会删除 %LOCALAPPDATA%\InternalBeyond，但 optional app-data checkbox 会递归删除 com.internalbeyond.desktop cache；这与 Inno 的“用户数据保留”语义不是同一条 policy。
4. 在同一目录场景下，它可能留下 Inno 的 VBS/sidecars/payload，也可能移除共享 shortcut；因此不能把 Tauri uninstall 当成 Existing Inno uninstall 的替代。

这三种情形均为基于 source、generated file list、registry 和 uninstall rules 的静态推演；为避免 Stop Condition #4，本轮没有执行任何一种。

## D. Registry Evidence

只查询了明确的 InternalBeyond keys；没有 dump 全注册表。

| Key | Owner | DisplayName | DisplayVersion | InstallLocation | UninstallString | QuietUninstallString | Publisher | InstallDate |
|---|---|---|---|---|---|---|---|---|
| HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\InternalBeyond | Tauri generated NSIS | InternalBeyond | 1.0.6 | [local path redacted] | [local path redacted] | absent | InternalBeyond | absent |
| HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{78B427F6-A48F-4443-86D5-2F50DC899D07}_is1 | Existing Inno | InternalBeyond 1.0.6 | 1.0.6 | [local path redacted] | [local path redacted] | same path + /SILENT | InternalBeyond | 20260917 |
| HKCU\Software\InternalBeyond\InternalBeyond | Tauri generated NSIS | default=[local path redacted]; Installer Language=1033 | n/a | n/a | n/a | n/a | n/a | n/a |

Additional targeted results:

- HKCU\Software\com.internalbeyond.desktop absent.
- HKLM normal uninstall and HKLM WOW6432Node uninstall have no matching InternalBeyond entry.
- Existing %LOCALAPPDATA%\InternalBeyond contains runtime/user state such as boot-state, logs, updates, credential-vault files, Bridge/Active/Home Node state; contents were not read.
- %LOCALAPPDATA%\Programs\InternalBeyond is absent.

## E. Ownership Matrix

分类约定：PRODUCT FILE = 可随版本替换的产品文件；RUNTIME FILE = 运行时/sidecar 文件；USER DATA = 用户不可因卸载丢失的数据；CACHE = 可重建缓存；BUILD ARTIFACT = 构建中间物；INSTALLER METADATA = registry/shortcut/uninstaller/update metadata。

| Artifact / State | Existing Inno | Tauri NSIS | Runtime owner | Canonical decision | Conflict |
|---|---|---|---|---|---|
| install directory | %LOCALAPPDATA%\Programs\InternalBeyond | %LOCALAPPDATA%\InternalBeyond | installer metadata | Existing Inno | same name, different paths |
| internalbeyond-host.exe | current payload absent | root host exe | Tauri host | Existing Inno after a safe integration; not implemented | current production gap |
| Web Core InternalBeyond.html | whitelist root payload | _up_ resource payload | static server / Tauri frontend | Existing Inno | duplicate physical resource trees |
| .tauri-frontend | not shipped | build frontendDist staging | src-tauri/build.rs | BUILD ARTIFACT only | junction/hardlink must not become install contract |
| docs/resources | Inno whitelist | _up_ resources | Project Knowledge / launcher | Existing Inno | duplicate copies |
| runtime/launch-internal-beyond.js | shipped | shipped under _up_ | launcher | Existing Inno | two physical copies if same root |
| VBS | shipped and used by shortcut | absent | browser fallback / old entry | Existing Inno for current round | Tauri shortcut cannot replace it safely yet |
| runner | shipped | resource copy | runtime | Existing Inno | duplicate |
| Home Node | shipped | resource copy | runtime | Existing Inno | duplicate |
| Bridge | shipped | resource copy | runtime | Existing Inno | duplicate |
| Active | shipped | resource copy | runtime | Existing Inno | duplicate |
| Vision | optional/not in canonical whitelist | not in Tauri resource list | optional runtime | Existing runtime policy | no current installer owner for optional module |
| icons | Inno payload + Inno shortcut/uninstall display | Tauri bundle icon + NSIS shortcut | UI shell | Existing Inno | same visible product name |
| Start Menu shortcut | InternalBeyond.lnk → wscript.exe + VBS; installer/InternalBeyond.iss:128-132 | InternalBeyond.lnk → host exe; generated NSIS installer.nsi:2022-2061 | installer metadata | Existing Inno | same visible shortcut name |
| Desktop shortcut | same as Inno Start Menu, opt-in | NSIS host shortcut | installer metadata | Existing Inno | same visible name |
| WebView2 | no logic | bootstrapper detect/download/install | OS/Tauri prerequisite | unresolved for a future production host; Tauri NSIS only today | canonical Inno host closure not proven |
| bundled Node | root runtime/node whitelist | _up_/runtime/node | launcher/runtime | Existing Inno | duplicate |
| VERSION | root payload and build define | _up_/VERSION and Cargo mirror | runtime/product-version.js | root VERSION | copies can drift if separately packaged |
| boot-state | %LOCALAPPDATA%\InternalBeyond\boot-state.json | same host-side path | launcher/host lifecycle | existing runtime data root | browser/Tauri cache remains separate |
| logs | generated outside payload | generated outside _up_ | launcher/services | runtime | must never be payload |
| user data | preserved by Inno | not deleted by default, optional Tauri cache deletion exists | user | existing %LOCALAPPDATA%\InternalBeyond | Tauri optional deletion semantics differ |
| IndexedDB/localStorage | browser origin | Tauri origin com.internalbeyond.desktop | WebView/browser | no migration this round | known P32-W degraded split |
| Home Node DB | user/runtime data | resource code only | Home Node | existing runtime data root | no DB migration allowed |
| uninstaller | unins000.exe + ib-stop.js | uninstall.exe + main-binary check | installer authority | Existing Inno | different ownership and stop semantics |
| registry uninstall entry | GUID _is1 | product-name key | installer metadata | Existing Inno | two visible entries |
| update metadata | update-stable.json and InternalBeyond-Setup-<v>.exe | no Tauri updater | existing updater | Existing Inno | Tauri NSIS filename is not update asset |

## F. Version Authority

当前版本没有 observed drift：

~~~text
root VERSION                  = 1.0.6
Cargo package version         = 1.0.6
Tauri generated VERSION       = 1.0.6 / 1.0.6.0
Inno AppVersion input         = root VERSION via build-installer.ps1
Inno PE ProductVersion check  = must equal root VERSION
update-stable.json            = InternalBeyond-Setup-1.0.6.exe
~~~

证据：

- root authority and consumers: runtime/product-version.js:4-21,27-32,51-82。
- Cargo/Tauri drift gate: src-tauri/build.rs:74-96。
- Inno compile define and PE read-back: scripts/build-installer.ps1:180-219,337-385。
- update asset naming: runtime/update-manifest.js:49-59,267-275。

最终版本模型应是：

~~~text
root VERSION
    ├── canonical Inno release
    └── Tauri host build mirror/check
~~~

不应把 Cargo、NSIS generated script 或 a manually typed installer version提升为第三个 authority。

## G. Architecture Decision

### Decision: Option A — Existing Installer remains canonical

理由是事实而不是因为 Inno 名字更旧：

1. Existing Inno 已经拥有 install、upgrade、uninstall、payload whitelist、bundled Node、launcher、service topology 和 user-data preservation。
2. Existing update chain 明确下载 Inno 命名的 release asset，并把停止、文件替换和 relaunch 留给 Inno。
3. Tauri NSIS 目前拥有不同的 identity、路径、shortcut、resource tree、WebView2 和 uninstaller 语义。
4. Tauri NSIS 不理解 Inno payload manifest，也不调用 ib-stop.js，不能无损覆盖现有 sidecar lifecycle。
5. 直接选择 Option B 会要求 storage/DB/launcher/service ownership migration；这些都是本轮禁止或 stop condition 范围。

因此唯一 canonical model 应为：

~~~text
ONE PRODUCT
ONE VERSION AUTHORITY = root VERSION
ONE PRODUCTION INSTALLER = Existing Inno
ONE PRODUCTION UPGRADE PATH = existing update -> Inno
ONE PRODUCTION UNINSTALL AUTHORITY = Inno
Tauri NSIS = development / packaging acceptance artifact only
~~~

Tauri NSIS 不删除、不改名为 production release，也不继续作为第二个可供用户选择的发布入口。

本决定已记录，但因 Stop Condition #4 没有进入实施阶段。

## H. Implementation

本轮未实施 installer convergence。原因是继续实施必然进入 build/install/uninstall 验证，而当前 smoke 的生产 AppId registry isolation 不成立。

本轮没有修改：

- installer/InternalBeyond.iss
- src-tauri/tauri.conf.json
- generated NSIS / Tauri bundle
- VERSION
- registry
- existing installer / Tauri installer artifacts
- launcher、Home Node、Bridge、Active、storage 或 DB

新增的只有本报告文件。

## I. Tauri Distribution Contract

当前尚不存在可被 Existing Inno 安全消费的 stable host distribution contract。

已观察到的 Tauri build layout：

- host executable：src-tauri/target/release/internalbeyond-host.exe
- frontend staging：src-tauri/build.rs:37-72 创建 .tauri-frontend，HTML hard link、目录 junction。
- NSIS acceptance resources：src-tauri/target/release/_up_
- NSIS generated script 把 source resources 复制到 _up_：installer.nsi:628-685

审计结论：

1. 不应把 src-tauri/target 交给生产 installer。
2. 不应把 build-time .tauri-frontend junction/hard link 当作安装目录 contract。
3. 不应把 Tauri _up_ 整棵树追加到 Inno；这会重新建立第二套 Web Core。
4. 后续安全实施应先产出一个稳定的、只含经过版本验证的 host distribution，再让 Inno staging 明确加入它；这一动作因 Stop Condition #4 未执行。

## J. Install Test

未执行。

静态原因已经足够阻止执行：tests/test_installer_smoke.js:80 固定使用生产 Inno GUID key，而 tests/test_installer_smoke.js:383-389 只隔离 /DIR，没有隔离该 HKCU uninstall key。当前该 key 已指向真实 [local path redacted]

## K. Upgrade Test

未执行。

静态审计确认 Existing Inno 的升级控制面存在：

- stop before replace：installer/InternalBeyond.iss:346-360
- shared stop helper：installer/InternalBeyond.iss:144-147
- manifest diff pruning：installer/InternalBeyond.iss:362-395
- runtime validation before relaunch：installer/InternalBeyond.iss:409-478

但没有在真实 registry state 下触发升级测试，也没有验证 Tauri host 加入后的 host process stop semantics。

## L. Uninstall Test

未执行。禁止对当前生产 AppId 运行临时 uninstaller。

Existing Inno 的静态语义是：

- unins000.exe 先调用 ib-stop.js：installer/InternalBeyond.iss:144-147
- 不存在 [UninstallDelete]，并且卸载说明明确保留 %LOCALAPPDATA%\InternalBeyond：installer/InternalBeyond.iss:397-406
- 用户数据不属于 payload manifest 的可删除对象；升级 stale cleanup 只接受 previous/new manifest 的文件差集：installer/tools/ib-stop.js:835-980

Tauri NSIS 的静态语义不同：

- 只检查主 host binary：installer.nsi:1323-1335
- optional checkbox 会删除 APPDATA/LOCALAPPDATA\com.internalbeyond.desktop：installer.nsi:1976-1992
- 不调用 Existing Inno 的 ib-stop.js

## M. Resource Closure

### Tauri acceptance closure

P32-W / P32-W.1 已记录 generated NSIS host 的 packaged resource probe：

- CSS、JS、background assets 在 tauri.localhost 上返回 200：docs/P32-W-WINDOWS-TAURI-PRODUCTIZATION.md:210-224
- Project Knowledge resource list 来自 src-tauri/tauri.conf.json:36-47
- host 通过 project_root、resource_dir、_up_ 和 executable directory 寻找资源：src-tauri/src/lib.rs:76-131,172-194
- host 复用既有 launcher，不重新实现服务拓扑：src-tauri/src/lib.rs:227-268

### Canonical Inno closure

尚未证明 Existing Inno → Tauri host → WebView2 → resources → sidecars 的完整链路，因为当前 Inno payload 没有 host executable，当前 shortcuts 仍然是 VBS：installer/InternalBeyond.iss:111-147。

Inno 自身的 Browser/Web Core closure 是已有 P7 authority；Tauri Host closure 仍属于实施后的 isolated acceptance gate，不能把 P32-W.1 的 NSIS evidence 冒充成 Inno evidence。

## N. Security

- Existing Inno：per-user、lowest privilege、无 Program Files、无 PATH/environment、无 Windows service/driver/firewall/task；installer/InternalBeyond.iss:60-98。
- Tauri NSIS：currentUser；src-tauri/tauri.conf.json:49-57。
- Tauri runtime capability 仍是最小集合；本轮没有增加 fs root、shell、opener 或 admin capability。
- Tauri NSIS 的 WebView2 bootstrapper 只属于 acceptance artifact 当前实现；Existing Inno 当前没有 WebView2 installer authority。
- 本轮没有执行任何 registry write，也没有改变 signing authority。

## O. Tests

### Read-only checks completed

| Command / probe | Result |
|---|---|
| git status --short --branch | 发现已有 P31/P32/P32-W dirty/untracked changes；本轮没有 reset/clean/checkout |
| targeted rg over installer/release/update/Tauri files | 找到 Inno source、generated NSIS、registry/update/shortcut/WebView2 evidence |
| node scripts/release-manifest.js | PASS：39 entries、348 files、missing/denied empty |
| targeted reg.exe query for HKCU/HKLM InternalBeyond keys | PASS：只读取得 D 节证据；没有 registry mutation |
| filesystem enumeration of [local path redacted] state | PASS：只读；没有删除/改写 |
| generated NSIS/static source inspection | PASS：identity/path/resource/uninstall semantics recorded |

### Intentionally not run

- Inno build
- Tauri build
- tests/test_installer_smoke.js --install-audit
- tests/test_installer_smoke.js --real-install-smoke
- any installer/uninstaller
- any registry-changing command

## P. Resource Cleanup

- 本轮没有创建临时安装目录。
- 本轮没有启动 InternalBeyond、Tauri host、Node sidecar 或 WebView2。
- 没有 PID 需要清理。
- 没有删除 [local path redacted] 或任何 installer artifact。
- 没有 registry cleanup，因为本轮没有写 registry。

## Q. Remaining

只列直接后续，不进入 P33/Android/UI redesign：

1. 先修复 smoke registry isolation：测试不能使用生产 Inno AppId；应使用 throwaway user/hive，或明确的 test-only AppId/installer identity，并验证 cleanup 不触碰生产 GUID key。
2. 重新审计并实现 stable Tauri Host Distribution Contract；只消费 host 和必要的真实资源，不复制 src-tauri/target，不复制第二套 Web Core，不保留 junction 作为最终安装资源。
3. 决定 Host 是否成为 canonical Inno 的主入口。旧 VBS 仍承担 bundled Node 解析、损坏 runtime 预检、日志和用户可理解错误；不能只改 shortcut 而不补齐这些语义。
4. 如果 Host 成为 canonical 主入口，单独设计一套明确的 WebView2 责任，并为 Inno upgrade/uninstall 增加 exact-host ownership handling；禁止 image-name broad kill。
5. 在新的 registry-isolated test harness 下，才执行 fresh install、host launch、CSS/JS/background/Project Knowledge/sidecars、upgrade、uninstall/data-preservation。
6. Browser/Tauri origin storage split、Home Node DB、Memory、Chat、API configs 和 boot-state 不在本轮迁移。

## Closure Gate

| Question | Canonical answer at the end of audit |
|---|---|
| InternalBeyond 正式由谁安装？ | Existing Inno；installer/InternalBeyond.iss |
| 正式由谁升级？ | Existing Inno，由 existing updater 下载并启动 |
| 正式由谁卸载？ | Existing Inno unins000.exe |
| VERSION 谁说了算？ | root VERSION |
| Tauri Host 由谁部署？ | 目标架构是 Existing Inno；当前尚未实施/验收，因此不能宣称已闭环 |
| Web Core 由谁部署？ | 当前正式 Browser/Web Core 由 Existing Inno whitelist；Tauri NSIS acceptance 自己有 _up_ |
| sidecars 由谁部署？ | Existing Inno whitelist + existing runtime launcher |
| WebView2 由谁负责？ | 当前只有 Tauri NSIS acceptance 负责 bootstrapper；正式 Inno Host 策略尚未闭合 |
| 快捷方式由谁创建？ | 当前正式 shortcut 由 Existing Inno，目标为 VBS；Tauri NSIS acceptance 另建 host shortcut |
| 用户数据谁拥有？ | %LOCALAPPDATA%\InternalBeyond 由用户/runtime 拥有；Tauri WebView cache 是另一个 origin |
| 卸载是否保留用户数据？ | Existing Inno 是；Tauri acceptance 的 optional cache deletion 语义不同 |
| NSIS 现在是什么身份？ | Development / packaging acceptance artifact only，不是 production installer |

**Closure Gate：NOT CLOSED。**  
Authority decision 已明确为 Existing Inno canonical，且 registry identity collision 已被证实为“同产品、不同 identity”；但由于生产 AppId 未隔离的 uninstall smoke 会触碰真实安装，本轮必须在这里停止，不能伪造 install/upgrade/uninstall 通过结论。

## Resume Evidence · P32-W.2

The historical Stop Condition above is retained. After P32-W.2A and P32-W.2B were closed, the formal Resume implemented and verified the stable Host integration:

- Existing Inno remains the sole production installer, updater target and uninstaller authority.
- A stable Host-only distribution is built from a locked Cargo mirror and staged as one `internalbeyond-host.exe`; Cargo target internals, `_up_`, `.tauri-frontend` and duplicate Web Core bytes are not installed.
- The Host is version-checked against root `VERSION=1.0.6`; final Host evidence was 9,081,856 bytes with SHA-256 `7e9ab48e25ee3b1a3e1de700d799f19c6bfdb2b560a82a8a3d30bffaa714b776`.
- Existing Inno installs the Host beside the canonical Web Core/runtime and its production shortcuts target `internalbeyond-host.exe`.
- Existing Inno owns WebView2 detection/bootstrap policy using the fixed Microsoft Evergreen bootstrapper URL; the acceptance machine detected WebView2 `153.0.4234.48`.
- Exact Host executable-path ownership is enforced by `ib-stop.js`; running upgrade and uninstall stopped only the current install-owned Host/runtime and preserved the unrelated decoy Node process.
- Test-only Inno install/launch/upgrade/uninstall acceptance completed 43/43; the install audit completed 22/22.
- Production Inno/Tauri registry snapshots, production shortcuts, production roots, VERSION and production dist artifacts remained invariant.

Current closure state: **P32-W.2 CLOSED**. Non-core limitations remain documented in the Resume integration report: full packaged DOM interaction coverage, live Astra credentials, Browser/Tauri storage split, signing and a production updater are not silently upgraded to PASS.
