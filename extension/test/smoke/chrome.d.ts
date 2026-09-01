/**
 * The slice of the `chrome.*` namespace the smoke tests touch from inside
 * extension pages via page.evaluate. Declared locally instead of pulling in
 * @types/chrome for a handful of calls; production code uses webextension-polyfill.
 */
declare namespace chrome {
  namespace storage {
    interface StorageArea {
      get(keys: null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    }
    const local: StorageArea;
    const sync: StorageArea;
  }
  namespace tabs {
    interface Tab {
      id?: number;
      windowId: number;
    }
    function query(info: { url?: string }): Promise<Tab[]>;
    function getCurrent(): Promise<Tab | undefined>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }
  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number };
      files: string[];
    }): Promise<unknown>;
  }
  namespace runtime {
    function sendMessage(message: unknown): Promise<unknown>;
  }
  namespace action {
    function getBadgeText(details: Record<string, never>): Promise<string>;
    function getTitle(details: Record<string, never>): Promise<string>;
  }
}
