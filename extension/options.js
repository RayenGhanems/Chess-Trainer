const DEFAULT_APP_ORIGIN = "http://127.0.0.1:8000";
const APP_ORIGIN_KEY = "reviewAppOrigin";

function normalizeAppOrigin(value) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_APP_ORIGIN;
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Review app origin must use http or https.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function loadOptions() {
  const stored = await chrome.storage.sync.get(APP_ORIGIN_KEY);
  document.querySelector("#app-origin").value = stored[APP_ORIGIN_KEY] || DEFAULT_APP_ORIGIN;
  document.querySelector("#status").dataset.state = "";
}

async function saveOptions() {
  const status = document.querySelector("#status");
  try {
    const normalized = normalizeAppOrigin(document.querySelector("#app-origin").value);
    await chrome.storage.sync.set({ [APP_ORIGIN_KEY]: normalized });
    status.textContent = "Saved.";
    status.dataset.state = "success";
  } catch (error) {
    status.textContent = error.message || "Could not save that origin.";
    status.dataset.state = "error";
  }
}

document.querySelector("#save").addEventListener("click", saveOptions);
loadOptions().catch((error) => {
  const status = document.querySelector("#status");
  status.textContent = error.message || "Could not load options.";
  status.dataset.state = "error";
});
