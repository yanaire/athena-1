# Athena 윈도우·인텔 맥 설치 안내

GitHub Actions는 Apple Silicon Mac과 Windows x64에서 데스크톱 앱을 빌드하고 설치를 검증합니다. Intel Mac은 같은 소스에서 수동으로 빌드할 수 있습니다. 검토 중인 빌드를 재현할 때는 PR 또는 Actions에 표시된 커밋을 체크아웃합니다.

## 어떤 버전을 만들면 되나요?

| 사용 컴퓨터 | 빌드 대상 | 생성되는 파일 |
| --- | --- | --- |
| Apple Silicon 맥 | `aarch64-apple-darwin` | Apple Silicon용 `Athena.app` |
| 애플 인텔 맥 | `x86_64-apple-darwin` | Intel용 `Athena.app` |
| Windows 10/11, Intel·AMD 64비트 | `x86_64-pc-windows-msvc` | `Athena_…_x64-setup.exe` |

각 버전은 해당 운영체제와 CPU 아키텍처에서 빌드합니다. 일반 명령 `npm run desktop:build`도 현재 컴퓨터를 자동 판별합니다. 인텔 맥에 Apple Silicon 앱을 설치하는 방식이 아니며, Intel용 Node와 분석 실행기가 앱에 함께 포함됩니다. Windows ARM64·32비트와 macOS Universal 앱은 이번 범위에 포함하지 않습니다.

현재 제공하는 경로는 개발용 소스 빌드입니다. 코드 서명된 공식 Windows 설치 파일이나 Apple 공증을 받은 배포판의 제공을 뜻하지 않습니다. CI 성공, 실제 계정 연결, 개인 컴퓨터 설치 확인은 각각 별도로 기록합니다.

## 1. Windows에서 설치 파일 만들기

### 처음 한 번 준비할 도구

- Git.
- [Node.js 24.22.3 x64](https://nodejs.org/dist/v24.22.3/). 다른 운영체제용 Node나 32비트 버전을 사용하지 않습니다.
- Python 3. 터미널에서 `python --version`으로 확인합니다.
- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). 설치 화면에서 **C++를 사용한 데스크톱 개발**과 Windows SDK를 선택합니다.
- [Rustup](https://rustup.rs/). MSVC 툴체인을 사용합니다.
- [.NET Framework 4.8 이상](https://learn.microsoft.com/ko-kr/dotnet/framework/install/on-windows-and-server). Windows 10 1903 이후 버전과 Windows 11에는 4.8 또는 4.8.1이 포함됩니다. Windows용 파일 권한 확인기가 이 시스템 런타임을 사용합니다.
- [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). 최신 런타임을 사용합니다. 앱의 비공개 웹뷰에는 **101.0.1210.39 이상**이 필요합니다([Wry 공식 지원 기준](https://docs.rs/wry/0.55.1/wry/struct.WebViewBuilder.html#method.with_incognito)).

도구 설치 뒤 새 **Developer PowerShell for Visual Studio**를 열고 진행합니다. 준비 항목의 공식 기준은 [Tauri Windows 사전 준비](https://v2.tauri.app/start/prerequisites/#windows)에 있습니다.

### 소스 받기와 빌드

```powershell
git clone https://github.com/yanaire/athena.git
cd athena
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
rustup toolchain install 1.99.1 --profile minimal --target x86_64-pc-windows-msvc
rustup override set 1.99.1
npm ci --ignore-scripts --no-audit --no-fund
npm run windows:prepare
python athena-backend-handoff/athena-codex-ui/build.py
npm run check
npm run analysis:prepare
npm run desktop:build:windows
```

Node 확인 결과는 `v24.22.3 win32 x64`여야 합니다. 첫 빌드는 Rust 의존성과 분석 런타임을 내려받고 컴파일하므로 시간이 걸립니다. 빌드 도중 원본 파일의 SHA-256을 확인하며, 일치하지 않으면 중단합니다.

`windows:prepare`는 Windows에 설치된 .NET Framework 컴파일러로 Athena의 파일 권한 확인기를 준비합니다. 완성된 앱에는 확인기가 포함되므로 앱 실행 중에 코드를 컴파일하지 않습니다. 소스에서 `npm start`, `npm test`, `npm run analysis:prepare`를 실행할 때도 준비 단계가 자동으로 실행됩니다.

설치 프로그램은 WebView2와 Athena 파일을 설치하기 전에 .NET Framework 4.8 이상인지 확인합니다. 조건을 만족하지 않으면 설치를 중단하고 Microsoft의 .NET Framework 설치를 안내합니다. 자동 설치(`/S`)에서는 대화창 없이 종료 코드 `2`를 반환합니다.

생성 위치:

```text
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/
```

폴더 안의 `Athena_…_x64-setup.exe`를 실행합니다. 한국어·영어 설치 화면을 지원하며 현재 사용자에게 설치합니다. WebView2가 없거나 101.0.1210.39보다 오래됐다면 설치 프로그램이 런타임 설치·업데이트를 요청하므로 인터넷 연결이 필요합니다. 설치 프로그램을 거치지 않고 빌드한 실행 파일을 직접 열 때도 최신 WebView2 Evergreen Runtime을 준비합니다. 설치된 앱을 실행할 때는 Node·Rust·Python을 따로 설치할 필요가 없습니다.

컴파일러를 찾지 못한다면 C++ 워크로드/Windows SDK 설치를 확인하고 Developer PowerShell을 다시 엽니다. `arm64` 또는 `ia32`가 표시되면 이번 빌드 대상과 다른 Node가 실행되고 있는 것입니다. 출처·서명에 관한 운영체제 경고는 공식 배포 서명을 추가해야 해결되는 별도 항목이며, 보호 기능을 끄는 절차는 이 설치 안내에 포함하지 않습니다.

## 2. 인텔 맥에서 앱 만들기

macOS 13.5 이상인 인텔 맥에서 진행합니다. [Node.js 24.22.3의 macOS x64 버전](https://nodejs.org/dist/v24.22.3/)과 Python 3, Rustup이 필요합니다. 터미널에서 Xcode Command Line Tools를 설치합니다.

```sh
xcode-select --install
```

설치가 끝난 뒤:

```sh
git clone https://github.com/yanaire/athena.git
cd athena
node -p "process.version + ' ' + process.platform + ' ' + process.arch"
rustup toolchain install 1.99.1 --profile minimal --target x86_64-apple-darwin
rustup override set 1.99.1
npm ci --ignore-scripts --no-audit --no-fund
python3 athena-backend-handoff/athena-codex-ui/build.py
npm run check
npm run analysis:prepare
npm run desktop:build:mac-intel
```

Node 확인 결과는 `v24.22.3 darwin x64`여야 합니다. 생성된 앱은 다음 위치에 있습니다.

```text
src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Athena.app
```

`Athena.app` 전체를 원하는 응용 프로그램 폴더로 복사해 실행합니다. 앱 내부의 파일을 따로 옮기면 포함된 호스트와 분석 실행기를 찾을 수 없습니다. 이 로컬 빌드의 ad-hoc 서명은 Developer ID 서명·Apple 공증과 구분합니다.

Apple Silicon 맥에서는 macOS **arm64용 Node 24.22.3**을 사용하고 Rust 대상을 `aarch64-apple-darwin`으로 선택한 뒤 `npm run desktop:build`를 실행합니다. Node 확인 결과는 `v24.22.3 darwin arm64`여야 합니다.

두 Mac에서 모두 앱 빌드 후 `node scripts/check-macos-dmg.mjs`를 실행하면 대상별 `release/bundle/dmg`에 DMG가 생성됩니다. DMG를 읽기 전용으로 열어 복사한 앱을 임시 작업공간에서 시작하고 종료한 뒤 결과를 기록합니다.

## 3. 처음 실행한 뒤 모델 연결

1. **Settings → Models & connections**를 엽니다.
2. 지원하는 API 계정 또는 OpenAI 호환 서버의 주소와 모델을 등록합니다.
3. 연결 검사를 실행하고 모델 프로필을 저장합니다.
4. 프로젝트와 대화를 만든 뒤 저장한 모델을 선택합니다.
5. 짧은 메시지로 응답을 확인하고, CSV 첨부와 서브에이전트 실행을 확인합니다.

자세한 설정은 [모델 연결 안내](model-providers.md)를 참고합니다. API 사용 비용은 선택한 제공자와 계정의 조건에 따릅니다. 앱에는 모델 가중치나 사용자의 API 키가 들어 있지 않습니다.

개인 로컬 ChatGPT 연결을 포함하는 개발 빌드가 필요하면 해당 운영체제에서 다음 명령을 사용합니다.

```sh
npm run desktop:build:local-chatgpt
```

일반 빌드와 다른 앱 식별자를 사용하지만 같은 대상의 빌드 출력 위치를 사용하므로 기존 출력은 먼저 별도 위치에 보관합니다. 실제 계정 자격·연결·콜백·모델 사용 가능 여부는 각 플랫폼에서 확인해야 합니다. [자세한 연결 절차](installation.md#personal-local-build-with-chatgpt)를 따릅니다.

## 4. 이번 변경의 검증 범위

자동 검사는 운영체제·아키텍처 일치, 타입과 UI, 호스트 회귀, 분석 런타임과 번들된 호스트의 스트리밍·도구 호출·저장·재시작을 확인합니다. Windows CI는 NSIS로 설치한 뒤 WebView2와 호스트의 연결을 확인하고 앱을 종료합니다. 제거 프로그램으로 설치 실행 파일과 호스트 리소스가 제거되는지도 확인합니다. macOS와 Windows의 설치 파일 이름 및 SHA-256은 [Actions](https://github.com/yanaire/athena/actions/workflows/verify.yml) 로그에서 확인할 수 있습니다.

채팅·워크플로우의 Chromium 검사 결과는 [워크플로우 검증 기록](workflow-dag.md)에, 아직 연결되지 않은 UI 기능은 [기능 점검표](ui-capability-audit.md)에 정리돼 있습니다. 이 문서에 새 플랫폼의 실제 빌드 성공을 소급해 가정하지 않습니다. 성공 여부는 해당 커밋의 CI 결과로 판단합니다.
