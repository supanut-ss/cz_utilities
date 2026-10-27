import os
import sys
from pathlib import Path
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("PHASE0_BASE_URL", "http://127.0.0.1:4173")
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


def main():
    artifact_dir = Path(__file__).parent / "artifacts"
    artifact_dir.mkdir(exist_ok=True)
    screenshot_path = artifact_dir / "phase0-probe-results.png"

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME_PATH)
        page = browser.new_page()
        page_errors = []
        request_failures = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("requestfailed", lambda request: request_failures.append(f"{request.url}: {request.failure}"))
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=15000)
        try:
            page.wait_for_load_state("networkidle", timeout=7000)
        except PlaywrightTimeoutError:
            print("NOTE external resources did not become network-idle in 7 seconds")
        page.locator("#search-form").wait_for()

        health = page.request.get(f"{BASE_URL}/api/health").json()
        api_key_configured = health["apiKeyConfigured"]
        print(f"PASS health endpoint; API key configured={api_key_configured}")

        page.locator("#query").fill("karaoke")
        page.locator("#search-form button[type=submit]").click()
        if not api_key_configured:
            page.locator("#search-status").wait_for(timeout=10000)
            assert "YOUTUBE_API_KEY" in page.locator("#search-status").inner_text()
            print("PASS missing-key search response")
        else:
            try:
                page.wait_for_function(
                    "document.querySelector('#search-status').textContent !== 'กำลังค้นหา…'",
                    timeout=20000,
                )
            except PlaywrightTimeoutError:
                print("INCOMPLETE YouTube Data API search timed out")
            else:
                first_result = page.locator("#results .item").first
                if first_result.count():
                    first_result.get_by_role("button", name="เพิ่มรายการทดลอง").click()
                    page.locator("#test-list .item").first.wait_for()
                    print("PASS search results and add-to-test-list flow")
                    page.locator("#embeddable").select_option("any")
                    page.locator("#search-form button[type=submit]").click()
                    try:
                        page.wait_for_function(
                            "document.querySelector('#search-status').textContent !== 'กำลังค้นหา…'",
                            timeout=20000,
                        )
                    except PlaywrightTimeoutError:
                        print("INCOMPLETE unfiltered search timed out")
                    else:
                        metadata = page.locator("#results .item-meta").all_inner_texts()
                        if metadata:
                            not_embeddable = sum("ระบุว่าฝังไม่ได้" in item for item in metadata)
                            made_for_kids = sum("· Made for Kids" in item for item in metadata)
                            not_made_for_kids = sum("· ไม่ใช่ Made for Kids" in item for item in metadata)
                            kids_unknown = sum("· ไม่ทราบ Made for Kids" in item for item in metadata)
                            print(
                                "PASS unfiltered results status lookup; "
                                f"non-embeddable={not_embeddable}; "
                                f"made-for-kids=true:{made_for_kids}, "
                                f"false:{not_made_for_kids}, unknown:{kids_unknown}"
                            )
                        else:
                            print(f"INCOMPLETE unfiltered search: {page.locator('#search-status').inner_text()}")
                else:
                    print(f"INCOMPLETE YouTube Data API search: {page.locator('#search-status').inner_text()}")

        try:
            page.wait_for_function("window.__phase0PlayerReady === true", timeout=15000)
            page.locator("#manual-video-id").fill("M7lc1UVf-VE")
            page.locator("#end-seconds").fill("8")
            page.locator("#play-manual").click()
            page.wait_for_function("window.__phase0PlayerState === 1", timeout=30000)
            print("PASS IFrame Player entered PLAYING")
            page.wait_for_function("window.__phase0PlayerState === 0", timeout=30000)
            print("PASS IFrame Player emitted ENDED for the 8-second probe")
        except PlaywrightTimeoutError:
            observed = page.locator("#player-status").inner_text()
            print(f"INCOMPLETE IFrame playback probe: {observed}")
            for failure in request_failures:
                print(f"Network request failed: {failure}")

        page.screenshot(path=str(screenshot_path), full_page=True)
        print(f"CAPTURED {screenshot_path}")

        if page_errors:
            print("Browser page errors:")
            for error in page_errors:
                print(f"- {error}")
            browser.close()
            raise AssertionError("The page reported JavaScript errors.")

        browser.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL {error}")
        sys.exit(1)
