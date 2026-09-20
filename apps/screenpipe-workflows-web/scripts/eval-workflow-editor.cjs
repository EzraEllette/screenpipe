// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const out = process.env.WORKFLOW_EDITOR_ARTIFACTS || require("node:path").join(require("node:os").tmpdir(), "screenpipe-workflow-editor-eval");
require("node:fs").mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const field = name => page.getByRole("textbox", { name, exact: true });
  const button = name => page.getByRole("button", { name, exact: true });
  const saved = () => page.getByRole("status", { name: "Save status" }).filter({ hasText: /^Saved$/ }).waitFor();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("screenpipe:fictional-workflow-editor-preview"))?.analysis.workflows.find(w => w.id === "Research synthesis"));
  const check = async (label, f) => { await f(); console.log("PASS", label); };
  try {
    await page.goto(process.env.WORKFLOWS_PREVIEW_URL || "http://127.0.0.1:1431/preview");
    await button("Open map").first().click();
    await check("workflow is editable immediately, without edit/save controls", async () => {
      await field("Workflow title").waitFor();
      assert.equal(await button("Edit workflow").count(), 0);
      assert.equal(await button("Edit steps").count(), 0);
      assert.equal(await button("Save").count(), 0);
      assert.equal(await button("Move step 1").getAttribute("draggable"), "true");
    });
    await check("drag step, auto-save and retain its screenshot", async () => {
      await button("Move step 1").dragTo(page.getByRole("article", { name: "Step 2", exact: true }));
      assert.equal(await field("Step 2 title").inputValue(), "Collect sources");
      await saved();
      const workflow = await stored();
      assert.equal(workflow.stages[1].name, "Collect sources");
      assert(workflow.stages[1].screenshot.dataUrl);
    });
    await check("undo works after automatic save", async () => {
      await button("Undo last edit").click();
      assert.equal(await field("Step 1 title").inputValue(), "Collect sources");
      await saved();
      assert.equal((await stored()).stages[0].name, "Collect sources");
    });
    await check("successive saved reorders preserve source identity", async () => {
      const before = await stored();
      await button("Move step 1").focus();
      await page.keyboard.press("Alt+ArrowDown");
      await saved();
      await button("Move step 2").focus();
      await page.keyboard.press("Alt+ArrowDown");
      await saved();
      const after = await stored();
      assert.equal(after.stages[2].name, "Collect sources");
      assert.deepEqual(after.stages[2].screenshot, before.stages[0].screenshot);
      await button("Move step 3").dragTo(page.getByRole("article", { name: "Step 1", exact: true }));
      await saved();
    });
    await check("typing auto-saves without losing focus", async () => {
      await field("Workflow title").fill("Research brief");
      await saved();
      assert(await field("Workflow title").evaluate(e => e === document.activeElement));
      assert.equal((await stored()).title, "Research brief");
    });
    await check("empty blocks remain drafts until filled", async () => {
      const before = await stored();
      await button("Add block").first().click();
      await page.getByText("Finish the empty block to save", { exact: true }).waitFor();
      await page.waitForTimeout(850);
      assert.equal((await stored()).revision, before.revision);
      await field("Block 1 in step 1").fill("Gather the dated source links.");
      await saved();
      await button("Add block").first().click();
      await field("Block 2 in step 1").fill("Check the source author.");
      await saved();
    });
    await check("drag blocks auto-saves their new order", async () => {
      await button("Move block 1 in step 1").dragTo(field("Block 2 in step 1"));
      await saved();
      assert.deepEqual((await stored()).stages[0].procedure.map(p => p.text), ["Check the source author.", "Gather the dated source links."]);
    });
    await check("failed auto-save keeps text, exposes retry, does not loop", async () => {
      await page.evaluate(() => {
        window.__setItem = Storage.prototype.setItem;
        window.__failedSaves = 0;
        Storage.prototype.setItem = function(k, v) {
          if (k === "screenpipe:fictional-workflow-editor-preview") { window.__failedSaves++; throw new Error("Simulated disk full"); }
          return window.__setItem.call(this, k, v);
        };
      });
      await field("Workflow description").fill("A traceable research brief for the team.");
      await page.getByRole("alert").filter({ hasText: "Simulated disk full" }).waitFor();
      await page.waitForTimeout(850);
      assert.equal(await page.evaluate(() => window.__failedSaves), 1);
      assert.equal(await field("Workflow description").inputValue(), "A traceable research brief for the team.");
      await page.evaluate(() => Storage.prototype.setItem = window.__setItem);
      await button("Retry save").click();
      await saved();
    });
    await check("leaving before debounce flushes valid changes", async () => {
      await field("Workflow outcome").fill("A reviewed brief is ready to share.");
      await button("All workflows").click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("screenpipe:fictional-workflow-editor-preview")).analysis.workflows.some(w => w.outcome === "A reviewed brief is ready to share."));
      await button("Open map").first().click();
      assert.equal(await field("Workflow outcome").inputValue(), "A reviewed brief is ready to share.");
    });
    await check("reload restores saved title, steps and blocks", async () => {
      await page.reload();
      await button("Open map").first().click();
      assert.equal(await field("Workflow title").inputValue(), "Research brief");
      assert.equal(await field("Step 1 title").inputValue(), "Collect sources");
      assert.equal(await field("Block 1 in step 1").inputValue(), "Check the source author.");
    });
    await check("concurrent change rejected with local draft retained", async () => {
      await page.evaluate(() => {
        const k = "screenpipe:fictional-workflow-editor-preview";
        const v = JSON.parse(localStorage.getItem(k));
        const workflow = v.analysis.workflows.find(w => w.id === "Research synthesis");
        workflow.revision++;
        workflow.title = "Another editor's title";
        localStorage.setItem(k, JSON.stringify(v));
      });
      await field("Workflow title").fill("My local draft");
      await page.getByRole("alert").filter({ hasText: "Workflow changed" }).waitFor();
      assert.equal(await field("Workflow title").inputValue(), "My local draft");
      assert.equal((await stored()).title, "Another editor's title");
      await button("Discard draft and view latest").click();
      assert.equal(await field("Workflow title").inputValue(), "Another editor's title");
    });
    await check("incomplete draft survives navigation", async () => {
      await button("Add step").click();
      await button("All workflows").click();
      await button("Open map").first().click();
      assert.equal(await field("Step 4 title").inputValue(), "");
      await field("Step 4 title").fill("Send for review");
      await saved();
    });
    await page.locator("[data-workflows-scroll-region]").evaluate(e => e.scrollTop = 0);
    await page.screenshot({ path: out + "/inline-workflow.png" });
    for (const width of [1050, 720, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await check(`fields and controls fit at ${width}px`, async () => {
        await page.waitForTimeout(100);
        const bad = await page.locator("main textarea, main button").evaluateAll(es => es.filter(e => e.getBoundingClientRect().width && (e.getBoundingClientRect().right > innerWidth + 1 || (e.tagName === "TEXTAREA" && e.scrollHeight > e.clientHeight + 3))).map(e => e.getAttribute("aria-label") || e.textContent));
        assert.deepEqual(bad, []);
      });
      await page.screenshot({ path: `${out}/inline-${width}.png` });
    }
    assert.deepEqual(errors, []);
    console.log("PASS no browser exceptions");
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
