"""Run with a Python environment containing CadQuery: python server.py."""
import argparse
import hashlib
import json
import math
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import cadquery as cq


DIMENSION = {"type": "number", "minimum": 0.1, "maximum": 200}
TOOL = {
    "name": "model_spacers",
    "description": "Create solid annular spacers, export STEP, then re-import and measure each solid. Units are mm.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "properties": {
            "outer_mm": DIMENSION, "height_mm": DIMENSION,
            "bores_mm": {"type": "array", "items": DIMENSION, "minItems": 1, "maxItems": 8, "uniqueItems": True},
        },
        "required": ["outer_mm", "height_mm", "bores_mm"],
    },
}


def model_spacers(outer_mm, height_mm, bores_mm):
    if not isinstance(bores_mm, list) or not 1 <= len(bores_mm) <= 8:
        raise ValueError("Choose one to eight bores.")
    for number in [outer_mm, height_mm, *bores_mm]:
        if type(number) not in (int, float) or not 0.1 <= number <= 200:
            raise ValueError("Dimensions must be between 0.1 and 200 mm.")
    if len(set(bores_mm)) != len(bores_mm) or max(bores_mm) >= outer_mm:
        raise ValueError("Bores must be distinct and smaller than the outer diameter.")
    rows, models = [], []
    for bore in bores_mm:
        with tempfile.TemporaryDirectory(prefix="athena-spacer-") as scratch:
            model = cq.Workplane("XY").circle(outer_mm / 2).circle(bore / 2).extrude(height_mm)
            path = Path(scratch) / "spacer.step"
            cq.exporters.export(model, str(path))
            restored = cq.importers.importStep(str(path)).val()
            if not restored.isValid() or len(restored.Solids()) != 1:
                raise ValueError("STEP did not round-trip as one valid solid.")
            step = path.read_bytes()
            expected = math.pi * height_mm * (outer_mm ** 2 - bore ** 2) / 4
            rows.append({
                "bore_mm": bore, "volume_mm3": restored.Volume(), "expected_mm3": expected,
                "solid_count": len(restored.Solids()),
            })
            models.append({
                "filename": f"spacer-{bore}mm.step",
                "sha256": hashlib.sha256(step).hexdigest(), "step": step.decode("ascii"),
            })
    return {"engine": "CadQuery", "version": cq.__version__, "outer_mm": outer_mm, "height_mm": height_mm, "rows": rows, "models": models}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/mcp" or self.headers.get("Origin") or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            self.send_error(403)
            return
        request_id = None
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 32768:
                raise ValueError("Invalid message size.")
            msg = json.loads(self.rfile.read(length))
            if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
                raise ValueError("Expected JSON-RPC 2.0.")
            request_id, method = msg.get("id"), msg["method"]
            if method == "notifications/initialized":
                self.send_response(202)
                self.end_headers()
                return
            if method == "initialize":
                result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "CadQuery spacer study", "version": "1.0.0"}}
            elif method == "tools/list":
                result = {"tools": [TOOL]}
            elif method == "tools/call" and msg["params"]["name"] == TOOL["name"]:
                output = model_spacers(**msg["params"]["arguments"])
                result = {"content": [{"type": "text", "text": f"Re-imported {len(output['rows'])} STEP solids."}],
                          "structuredContent": output}
            else:
                raise ValueError("Unknown method or tool.")
            response = {"result": result}
        except (ValueError, TypeError, KeyError, RuntimeError) as exc:
            response = {"error": {"code": -32602, "message": str(exc)}}
        raw = json.dumps({"jsonrpc": "2.0", "id": request_id, **response}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=14791)
    args = parser.parse_args()
    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        print(f"http://127.0.0.1:{server.server_port}/mcp", flush=True)
        server.serve_forever()
