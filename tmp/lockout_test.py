import json
import pathlib
import subprocess
import time

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
TARGET_BASE = "http://127.0.0.1:4173/"

server = subprocess.Popen(["py", "-3", "-m", "http.server", "4173"], cwd=PUBLIC)
time.sleep(1.5)

results = []
console_messages = []

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.on("console", lambda msg: console_messages.append({
            "type": msg.type,
            "text": msg.text,
        }))

        page.goto(f"{TARGET_BASE}?ts={time.time_ns()}", wait_until="domcontentloaded")
        page.wait_for_selector("#auth-code")

        # Wrong access code
        page.fill("#auth-code", "wrong-code")
        page.click("#auth-form button[type=submit]")
        early_sample = {}
        try:
            page.wait_for_timeout(220)
            early_sample = page.eval_on_selector(
                "body",
                "el => ({ lockout: el.classList.contains('lockout-active'), classes: el.className })",
            )
        except PlaywrightTimeoutError:
            pass
        page.wait_for_timeout(5200)
        access_overlay_state = page.eval_on_selector(
            "#lockout-overlay",
            "el => ({ hidden: el.classList.contains('is-hidden'), active: el.classList.contains('is-active'), className: el.className })",
        )
        body_state = page.eval_on_selector(
            "body",
            "el => ({ lockout: el.classList.contains('lockout-active'), classes: el.className })",
        )
        results.append({
            "scenario": "access",
            "overlay": access_overlay_state,
            "body": body_state,
            "bodyEarly": early_sample,
        })
        browser.close()
finally:
    server.terminate()
    try:
        server.wait(timeout=3)
    except subprocess.TimeoutExpired:
        server.kill()

output_path = ROOT / "tmp" / "lockout_results.json"
output_path.write_text(json.dumps({"results": results, "console": console_messages}, indent=2))
print(f"Wrote results to {output_path}")
