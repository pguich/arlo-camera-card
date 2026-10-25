import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { HomeAssistant } from "custom-card-helpers";
import { CardConfig, CardMode, FilterState, LibraryItem } from "./types";
import { fetchLibrary, fetchStreamUrl, stopActivity } from "./api";
import { applyFilters } from "./filters";
import { groupByDay, DayGroup, timeSettingsFromHass } from "./grouping";
import { cameraTile } from "./live-grid";
import { PlayerSource } from "./player-dialog";
import { CARD_VERSION } from "./version";

// Pull in the sub-components so customElements are defined in the bundle.
import "./live-grid";
import "./filter-bar";
import "./recordings-grid";
import "./player-dialog";
import "./editor";

const EMPTY_FILTER: FilterState = {
  cameras: null,
  trigger: null,
  fromMs: null,
  toMs: null,
};

type ResolvedConfig = CardConfig & {
  cameras: string[];
  default_mode: CardMode;
  columns?: number; // undefined = responsive auto-fit
  snapshot_refresh: number;
  library_days: number;
};

@customElement("arlo-camera-card")
export class ArloCameraCard extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;

  @state() private _config!: ResolvedConfig;
  @state() private _mode: CardMode = "live";
  @state() private _filter: FilterState = EMPTY_FILTER;
  @state() private _library: LibraryItem[] = [];
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _player?: PlayerSource;
  @state() private _playList: LibraryItem[] = [];
  @state() private _playIndex = -1;

  setConfig(config: CardConfig): void {
    if (config.cameras && !Array.isArray(config.cameras)) {
      throw new Error("`cameras` must be a list of camera entity ids");
    }
    const mode: CardMode = config.default_mode ?? "live";
    this._config = {
      ...config,
      cameras: config.cameras ?? [],
      default_mode: mode,
      columns: config.columns,
      snapshot_refresh: config.snapshot_refresh ?? 10,
      library_days: config.library_days ?? 7,
    };
    this._mode = mode;
  }

  /** Lovelace visual editor for this card. */
  static getConfigElement(): HTMLElement {
    return document.createElement("arlo-camera-card-editor");
  }

  /** Default config when added from the card picker. */
  static getStubConfig(hass: HomeAssistant): CardConfig {
    const cams = Object.keys(hass?.states ?? {}).filter((e) =>
      e.startsWith("camera.aarlo_")
    );
    return { type: "custom:arlo-camera-card", cameras: cams };
  }

  getCardSize(): number {
    return 8;
  }

  private get _cameras(): string[] {
    if (this._config.cameras.length) return this._config.cameras;
    return Object.keys(this.hass?.states ?? {}).filter((e) =>
      e.startsWith("camera.aarlo_")
    );
  }

  static styles = css`
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
    }
    .tab {
      flex: 1;
      text-align: center;
      padding: 9px;
      border-radius: 9px;
      background: var(--secondary-background-color, #2c2c2e);
      color: var(--secondary-text-color, #aaa);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    }
    .tab.active {
      background: var(--primary-color, #0a84ff);
      color: #fff;
    }
    ha-card {
      padding: 14px;
    }
  `;

  private async _switchMode(mode: CardMode) {
    this._mode = mode;
    if (mode === "recordings" && this._library.length === 0) {
      await this._loadLibrary();
    }
  }

  private async _loadLibrary() {
    this._loading = true;
    this._error = "";
    const atMost = Math.max(20, this._config.library_days * 30);
    try {
      const lists = await Promise.all(
        this._cameras.map((id) => fetchLibrary(this.hass, id, atMost))
      );
      this._library = lists.flat();
    } catch (e) {
      this._error = "Couldn't load recordings (Arlo library unavailable).";
    } finally {
      this._loading = false;
    }
  }

  private get _groups(): DayGroup[] {
    const filtered = applyFilters(this._library, this._filter);
    const t = timeSettingsFromHass(this.hass as any);
    return groupByDay(filtered, t.timeZone, Date.now(), t.locale);
  }

  private async _openLive(entityId: string) {
    const name = cameraTile(this.hass, entityId).name;
    this._player = { kind: "live", entityId, url: "", title: name };
    try {
      const url = await fetchStreamUrl(this.hass, entityId);
      this._player = { kind: "live", entityId, url, title: name };
    } catch (e) {
      // player-dialog shows its own error/timeout state; leave url empty.
    }
  }

  private _openClip(item: LibraryItem) {
    const list = applyFilters(this._library, this._filter).sort(
      (a, b) => b.created_at - a.created_at
    );
    this._playList = list;
    this._playIndex = list.findIndex((i) => i.url === item.url);
    this._showClipAt(this._playIndex);
  }

  private _showClipAt(index: number) {
    const item = this._playList[index];
    if (!item) return;
    this._playIndex = index;
    this._player = {
      kind: "clip",
      url: item.url,
      title: `${cameraTile(this.hass, item.entity_id).name}`,
    };
  }

  private _onNav(dir: -1 | 1) {
    const next = this._playIndex + dir;
    if (next >= 0 && next < this._playList.length) this._showClipAt(next);
  }

  private async _closePlayer() {
    const p = this._player;
    this._player = undefined;
    this._playList = [];
    this._playIndex = -1;
    if (p && p.kind === "live") {
      try {
        await stopActivity(this.hass, p.entityId);
      } catch (e) {
        /* best-effort teardown */
      }
    }
  }

  render() {
    if (!this._config) return html``;
    return html`
      <ha-card>
        <div class="tabs">
          <div
            class="tab ${this._mode === "live" ? "active" : ""}"
            @click=${() => this._switchMode("live")}
          >
            Live
          </div>
          <div
            class="tab ${this._mode === "recordings" ? "active" : ""}"
            @click=${() => this._switchMode("recordings")}
          >
            Recordings
          </div>
        </div>

        ${this._mode === "live"
          ? html`<arlo-live-grid
              .hass=${this.hass}
              .cameras=${this._cameras}
              .columns=${this._config.columns}
              .refresh=${this._config.snapshot_refresh}
              @open-live=${(e: CustomEvent) => this._openLive(e.detail.entityId)}
            ></arlo-live-grid>`
          : html`
              <arlo-filter-bar
                .hass=${this.hass}
                .cameras=${this._cameras}
                .filter=${this._filter}
                @filter-change=${(e: CustomEvent) =>
                  (this._filter = e.detail.filter)}
              ></arlo-filter-bar>
              <arlo-recordings-grid
                .groups=${this._groups}
                .columns=${this._config.columns}
                .loading=${this._loading}
                .error=${this._error}
                .time=${timeSettingsFromHass(this.hass as any)}
                @play-clip=${(e: CustomEvent) => this._openClip(e.detail.item)}
                @retry=${() => this._loadLibrary()}
              ></arlo-recordings-grid>
            `}

        <arlo-player-dialog
          .source=${this._player}
          .navigable=${this._player?.kind === "clip"}
          @player-close=${() => this._closePlayer()}
          @player-nav=${(e: CustomEvent) => this._onNav(e.detail.dir)}
        ></arlo-player-dialog>
      </ha-card>
    `;
  }
}

// Register in the card picker.
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: "arlo-camera-card",
  name: "Arlo Camera Card",
  description: "Live view + recordings for Arlo cameras (requires hass-aarlo).",
  preview: false,
  documentationURL: "https://github.com/shouldbecommitted/arlo-camera-card",
});

// eslint-disable-next-line no-console
console.info(
  `%c ARLO-CAMERA-CARD %c v${CARD_VERSION} `,
  "color: white; background: #0a84ff; font-weight: 700;",
  "color: #0a84ff; background: #1c1c1e; font-weight: 700;"
);
