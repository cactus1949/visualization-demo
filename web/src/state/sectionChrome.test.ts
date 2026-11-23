import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reduceSectionChrome, sectionChromeWhenEnabled, type SectionChrome } from "./sectionChrome.ts";

const off: SectionChrome = { enabled: false, floatOpen: false, collapsed: false, kind: "height" };

describe("section tool chrome", () => {
  it("opens a longitude section and the config, then the main button turns the section off", () => {
    const opened = reduceSectionChrome(off, "main");
    assert.equal(opened.enabled, true);
    assert.equal(opened.floatOpen, true);
    assert.equal(opened.kind, "lon");
    const closed = reduceSectionChrome(opened, "main");
    assert.equal(closed.enabled, false);
    assert.equal(closed.floatOpen, false);
  });

  it("hides the config without turning the section off, and the settings button opens it again", () => {
    const opened = reduceSectionChrome(off, "main");
    const hidden = reduceSectionChrome(opened, "close");
    assert.equal(hidden.enabled, true);
    assert.equal(hidden.floatOpen, false);
    const again = reduceSectionChrome(hidden, "settings");
    assert.equal(again.enabled, true);
    assert.equal(again.floatOpen, true);
    const folded = reduceSectionChrome(again, "collapse");
    assert.equal(folded.enabled, true);
    assert.equal(folded.collapsed, true);
  });

  it("closes the config when the section is turned off by the volume mutex", () => {
    const opened = reduceSectionChrome(off, "main");
    const muted = sectionChromeWhenEnabled(opened, false);
    assert.equal(muted.enabled, false);
    assert.equal(muted.floatOpen, false);
  });
});
