import { test } from "playwright/test";

test("video creator loads", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
  await page.getByText("Video Creator", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "tmp-video-creator.png", fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
});
