#!/usr/bin/env python3
"""Build Athena's dependency-free preview from its editable source files."""
from pathlib import Path
import argparse
import base64

ROOT = Path(__file__).resolve().parent
CSS_FILES = ["app.css", "motion/composer.css", "motion/controls.css", "ui/pi-activity.css", "motion/agent-steps.css", "motion/reply.css", "motion/task-list.css", "ui/agent-avatars.css", "ui/workspace-chrome.css", "ui/pi-session-view.css", "ui/workflow-graph.css", "ui/workspace-views.css", "ui/model-settings.css", "ui/provider-profiles.css", "ui/knowledge.css", "ui/surfaces.css", "ui/layout.css", "ui/resize.css", "ui/settings.css", "ui/pi-workbench.css", "ui/pi-shell.css", "ui/chat-model-picker.css", "ui/research-records.css", "ui/conversation-stream.css", "ui/extensions.css", "ui/research-board.css"]
JS_FILES = ["ui/activity-labels.js", "ui/pi-activity.js", "ui/pi-runtime.js", "motion/composer.js", "motion/controls.js", "motion/agent-steps.js", "motion/reply.js", "motion/task-list.js", "ui/agent-avatars.js", "ui/workspace-store.js", "ui/workspace-session.js", "ui/research-records.js", "ui/research-board.js", "ui/manuscripts.js", "ui/research-flow.js", "ui/result-files.js", "ui/workflow-graph.js", "ui/workspace-views.js", "ui/connection-manager.js", "ui/model-settings.js", "ui/provider-profiles.js", "ui/extensions.js", "ui/knowledge.js", "ui/workspace-chrome.js", "ui/pi-session-view.js", "ui/conversation-stream.js", "ui/surfaces.js", "ui/resize.js", "ui/settings.js", "ui/pi-workbench.js", "ui/chat-model-picker.js", "app.js"]


def source(name):
    return (ROOT / name).read_text(encoding="utf-8")


def asset_uri(name):
    mime = "application/pdf" if name.endswith(".pdf") else "image/png"
    return "data:" + mime + ";base64," + base64.b64encode((ROOT / name).read_bytes()).decode("ascii")


def embed_assets(content):
    for name in ["assets/athena-icon-128.png", "assets/athena-icon-32.png", "assets/sample-research-note.pdf"]:
        content = content.replace(name, asset_uri(name))
    return content


def script(content):
    return "<script>\n" + embed_assets(content).replace("</script", "<\\/script") + "\n</script>\n"


def build(inline_path=None, show_settings=False, show_agents=False):
    styles = "<style>\n" + "\n".join(source(name) for name in CSS_FILES) + "\n</style>\n"
    body = embed_assets(source("app.html"))
    scripts = "".join(script(source(name)) for name in JS_FILES)
    fragment = styles + body + "\n" + scripts
    standalone = (
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>Athena · Research workspace</title>\n'
        '<meta name="description" content="Athena research workspace with resizable panels, inline agent activity, tool execution, workflows, artifacts, model preferences, and project knowledge.">\n'
        + script("if(window.AthenaHosted===true||(/^https?:$/.test(location.protocol)&&location.pathname==='/'))document.documentElement.dataset.athenaHosted='true';")
        +
        '<link rel="icon" type="image/png" href="' + asset_uri("assets/athena-icon-32.png") + '">\n'
        '<style>body{margin:0;background:#f5f4ed}noscript{display:block;padding:24px;font-family:system-ui}</style>\n'
        + styles + '</head>\n<body>\n' + body
        + '<noscript>Enable JavaScript to use the conversation, panels, and settings.</noscript>\n'
        + script(source("vendor/lucide.min.js")) + scripts
        + '</body>\n</html>\n'
    )
    output = ROOT / "athena-preview.html"
    output.write_text(standalone, encoding="utf-8")
    print(f"Built {output.name} ({output.stat().st_size:,} bytes)")
    if inline_path:
        path = Path(inline_path)
        inline_styles = "<style>#athena-codex{height:min(860px,100dvh);min-height:0}@media(max-width:760px){#athena-codex{height:min(820px,100dvh)}}</style>\n"
        initial_view = script("window.AthenaApp?.openWorkspace('timeline');") if show_agents else script("window.AthenaApp?.openSettings('general');") if show_settings else ""
        path.write_text(styles + inline_styles + body + "\n" + scripts + initial_view, encoding="utf-8")
        assert path.stat().st_size < 1024 * 1024
        print(f"Built inline preview ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inline", help="Optional conversation preview fragment destination")
    preview = parser.add_mutually_exclusive_group()
    preview.add_argument("--show-settings", action="store_true", help="Open Settings in the inline preview only")
    preview.add_argument("--show-agents", action="store_true", help="Open Agents in the inline preview only")
    args = parser.parse_args()
    build(args.inline, args.show_settings, args.show_agents)
