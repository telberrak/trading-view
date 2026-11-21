# PyInstaller recipe for the desktop app's backend: pyinstaller tv-backend.spec  ->  dist/tv-backend/
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("ib_async", "eventkit", "tzdata"):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hiddenimports += h
hiddenimports += collect_submodules("uvicorn") + collect_submodules("app") + collect_submodules("websockets") + collect_submodules("httpx")

a = Analysis(["run.py"], pathex=["."], binaries=binaries, datas=datas, hiddenimports=hiddenimports,
             excludes=["tkinter"], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="tv-backend", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="tv-backend")
