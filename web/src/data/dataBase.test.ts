import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDataBase } from "./dataBase.ts";

test("default base keeps root-relative URLs", () => {
  assert.equal(resolveDataBase(undefined, "/"), "");
});

test("sub path base puts data under it", () => {
  assert.equal(resolveDataBase(undefined, "/viz/"), "/viz");
  assert.equal(resolveDataBase(undefined, "/viz"), "/viz");
});

test("VITE_DATA_BASE wins over the vite base", () => {
  assert.equal(resolveDataBase("https://cdn.example.com/wx/", "/viz/"), "https://cdn.example.com/wx");
  assert.equal(resolveDataBase("/other", "/viz/"), "/other");
});

test("empty VITE_DATA_BASE counts as unset", () => {
  assert.equal(resolveDataBase("", "/viz/"), "/viz");
  assert.equal(resolveDataBase("", "/"), "");
  assert.equal(resolveDataBase("", "./", "http://h/viz/"), "/viz");
  assert.equal(resolveDataBase("/other", "/viz/"), "/other");
});

test("relative base resolves against the page", () => {
  assert.equal(resolveDataBase(undefined, "./", "http://h/viz/index.html?x=1"), "/viz");
  assert.equal(resolveDataBase(undefined, "./", "http://h/viz/"), "/viz");
  assert.equal(resolveDataBase(undefined, "./", "http://h/"), "");
});
