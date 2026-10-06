"""Record demo.html into demo.mp4 and demo.gif.

Steps the page's clock frame by frame (window.renderAt), screenshots each frame
in headless Chromium, then encodes with ffmpeg.

    python3 demo/record.py            # needs playwright (python) and ffmpeg
"""
import pathlib
import shutil
import subprocess
import tempfile

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
DURATION = 24
FPS = 30


def main() -> None:
    frames = pathlib.Path(tempfile.mkdtemp(prefix="demo-frames-"))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=1)
        page.goto((HERE / "demo.html").as_uri() + "?t=0")
        page.evaluate("document.fonts.ready")
        for i in range(DURATION * FPS):
            page.evaluate(f"window.renderAt({i / FPS})")
            page.screenshot(path=str(frames / f"f{i:04d}.png"))
        browser.close()

    pattern = str(frames / "f%04d.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", pattern,
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
                    str(HERE / "demo.mp4")], check=True)
    gif_filter = ("fps=15,scale=960:-1:flags=lanczos,split[a][b];"
                  "[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", pattern,
                    "-vf", gif_filter, str(HERE / "demo.gif")], check=True)
    shutil.rmtree(frames)


if __name__ == "__main__":
    main()
