// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const out =
  process.env.WORKFLOW_EDITOR_ARTIFACTS ||
  require("node:path").join(
    require("node:os").tmpdir(),
    "screenpipe-workflow-editor-eval",
  );
require("node:fs").mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch({ headless: true, channel: "chrome" });
  const p = await b.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const check = async (label, f) => {
    await f();
    console.log("PASS", label);
  };
  const field = (n) => p.getByRole("textbox", { name: n, exact: true });
  const button = (n) => p.getByRole("button", { name: n, exact: true });
  try {
    await p.goto(
      process.env.WORKFLOWS_PREVIEW_URL || "http://127.0.0.1:1431/preview",
    );
    await p.getByRole("button", { name: "Open map" }).first().click();
    await button("Edit workflow").click();
    await check("save disabled for unchanged draft", async () =>
      assert(await button("Save").isDisabled()),
    );
    await check("inline edit + undo", async () => {
      await field("Workflow title").fill("Research brief");
      await button("Undo last edit").click();
      assert.equal(
        await field("Workflow title").inputValue(),
        "Research synthesis",
      );
      await field("Workflow title").fill("Research brief");
    });
    await check("keyboard stage reorder", async () => {
      await button("Move step 1").focus();
      await p.keyboard.press("Alt+ArrowDown");
      assert.equal(await field("Step 2 title").inputValue(), "Collect sources");
    });
    await check("drag step reorder", async () => {
      await button("Move step 2").dragTo(
        p.getByRole("article", { name: "Step 1", exact: true }),
      );
      assert.equal(await field("Step 1 title").inputValue(), "Collect sources");
    });
    await check("new block validation + keyboard reorder", async () => {
      await button("Add block").first().click();
      assert(await button("Save").isDisabled());
      await field("Block 1 in step 1").fill(
        "Gather source links in the research note.",
      );
      await button("Add block").first().click();
      await field("Block 2 in step 1").fill(
        "Check that every source is dated.",
      );
      await button("Move block 2 in step 1").focus();
      await p.keyboard.press("Alt+ArrowUp");
      assert.equal(
        await field("Block 1 in step 1").inputValue(),
        "Check that every source is dated.",
      );
    });
    await check("drag block reorder", async () => {
      await button("Move block 1 in step 1").dragTo(field("Block 2 in step 1"));
      assert.equal(
        await field("Block 1 in step 1").inputValue(),
        "Gather source links in the research note.",
      );
    });
    await check("add step + delete + undo", async () => {
      await button("Add step").click();
      await field("Step 4 title").fill("Send for review");
      await field("Step 4 description").fill(
        "Ask the project owner to review the brief.",
      );
      await button("Delete step 4").click();
      assert.equal(await field("Step 4 title").count(), 0);
      await button("Undo last edit").click();
      assert.equal(await field("Step 4 title").inputValue(), "Send for review");
    });
    await p
      .locator("[data-workflows-scroll-region]")
      .evaluate((e) => (e.scrollTop = 0));
    await p.screenshot({ path: out + "/edited-blocks.png" });
    await check("failed save keeps draft", async () => {
      await p.evaluate(() => {
        window.__setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (k === "screenpipe:fictional-workflow-editor-preview")
            throw new Error("Simulated disk full");
          return window.__setItem.call(this, k, v);
        };
      });
      await button("Save").click();
      await p
        .getByRole("alert")
        .filter({ hasText: "Simulated disk full" })
        .waitFor();
      assert.equal(
        await field("Workflow title").inputValue(),
        "Research brief",
      );
      await p.evaluate(() => (Storage.prototype.setItem = window.__setItem));
    });

    await check("save + reload persistence", async () => {
      await button("Save").click();
      await button("Edit workflow").waitFor();
      await p.reload();
      await p.getByRole("button", { name: "Open map" }).first().click();
      await button("Edit workflow").click();
      assert.equal(
        await field("Workflow title").inputValue(),
        "Research brief",
      );
      assert.equal(await field("Step 4 title").inputValue(), "Send for review");
      assert.equal(
        await field("Block 2 in step 1").inputValue(),
        "Check that every source is dated.",
      );
    });
    await check("concurrent write is rejected with draft kept", async () => {
      await field("Workflow title").fill("My concurrent draft");
      await p.evaluate(() => {
        const k = "screenpipe:fictional-workflow-editor-preview";
        const v = JSON.parse(localStorage.getItem(k));
        v.analysis.workflows.find(
          (w) => w.id === "Research synthesis",
        ).revision += 1;
        localStorage.setItem(k, JSON.stringify(v));
      });
      await button("Save").click();
      await p
        .getByRole("alert")
        .filter({ hasText: "Workflow changed" })
        .waitFor();
      assert.equal(
        await field("Workflow title").inputValue(),
        "My concurrent draft",
      );
    });
    await check("cancel leaves saved content unchanged", async () => {
      await button("Cancel edits").click();
      await button("Edit workflow").click();
      assert.equal(
        await field("Workflow title").inputValue(),
        "Research brief",
      );
    });
    await check("incomplete draft survives navigation", async () => {
      await button("Add step").click();
      await p
        .getByRole("button", { name: "Home", exact: false })
        .first()
        .click();
      await p.getByRole("button", { name: "Open map" }).first().click();
      await button("Edit workflow").click();
      assert.equal(await field("Step 5 title").count(), 1);
      assert(await button("Save").isDisabled());
      await button("Cancel edits").click();
    });
    await button("Edit workflow").click();
    await p.setViewportSize({ width: 720, height: 1000 });
    await p.waitForTimeout(250);
    await check("narrow fields fit their contents", async () => {
      const clipped = await p
        .locator("textarea")
        .evaluateAll((es) =>
          es
            .filter((e) => e.scrollHeight > e.clientHeight + 3)
            .map((e) => e.getAttribute("aria-label")),
        );
      assert.deepEqual(clipped, []);
    });
    await p.screenshot({ path: out + "/editor-narrow-tested.png" });
    await p.emulateMedia({ colorScheme: "dark" });
    await p.screenshot({ path: out + "/editor-dark-preference.png" });
    assert.deepEqual(errors, []);
    console.log("PASS no browser exceptions");
  } finally {
    await b.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
