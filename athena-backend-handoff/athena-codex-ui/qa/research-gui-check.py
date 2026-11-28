"""Acceptance-only X11 fixture. Run under xvfb-run on a fresh private display."""
import ctypes
import ctypes.util
import json
import math
import sys
import tkinter as tk

settings = json.load(sys.stdin)
root = tk.Tk()
root.title("Circuit verification")
out = tk.StringVar(value="Waiting for calculation")

def calculate():
    tau = settings["resistanceOhm"] * settings["capacitanceFarad"]
    values = [settings["inputVolt"] * (1 - math.exp(-t / tau)) for t in settings["sampleTimesSeconds"]]
    out.set(json.dumps(values))

button = tk.Button(root, text="Calculate voltages", command=calculate)
button.pack(padx=16, pady=16)
tk.Label(root, textvariable=out).pack()
root.update()
x11 = ctypes.CDLL(ctypes.util.find_library("X11"))
xtest = ctypes.CDLL(ctypes.util.find_library("Xtst"))
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
display = ctypes.c_void_p(x11.XOpenDisplay(None))
if not display:
    raise RuntimeError("Private X11 display unavailable")
x = button.winfo_rootx() + button.winfo_width() // 2
y = button.winfo_rooty() + button.winfo_height() // 2
xtest.XTestFakeMotionEvent(display, -1, x, y, 0)
xtest.XTestFakeButtonEvent(display, 1, True, 0)
xtest.XTestFakeButtonEvent(display, 1, False, 0)
x11.XSync(display, False)
root.update()
print(json.dumps({"voltages": json.loads(out.get()), "action": "X11 pointer click", "widget": button.cget("text")}))
root.destroy()
