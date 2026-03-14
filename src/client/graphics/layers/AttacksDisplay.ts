import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { EventBus } from "../../../core/EventBus";
import { Cell, MessageType, PlayerType, UnitType } from "../../../core/game/Game";
import {
  AttackUpdate,
  GameUpdateType,
  UnitIncomingUpdate,
} from "../../../core/game/GameUpdates";
import { GameView, PlayerView, UnitView } from "../../../core/game/GameView";
import { TransformHandler } from "../TransformHandler";
import {
  CancelAttackIntentEvent,
  CancelBoatIntentEvent,
  SendAttackIntentEvent,
} from "../../Transport";
import { renderTroops, translateText } from "../../Utils";
import { getColoredSprite } from "../SpriteLoader";
import { UIState } from "../UIState";
import { Layer } from "./Layer";
import {
  GoToPlayerEvent,
  GoToPositionEvent,
  GoToUnitEvent,
} from "./Leaderboard";
import soldierIcon from "/images/SoldierIcon.svg?url";
import swordIcon from "/images/SwordIcon.svg?url";

@customElement("attacks-display")
export class AttacksDisplay extends LitElement implements Layer {
  public eventBus: EventBus;
  public game: GameView;
  public uiState: UIState;
  public transform?: TransformHandler;

  private active: boolean = false;
  private incomingBoatIDs: Set<number> = new Set();
  private spriteDataURLCache: Map<string, string> = new Map();
  @state() private _isVisible: boolean = false;
  @state() private incomingAttacks: AttackUpdate[] = [];
  @state() private outgoingAttacks: AttackUpdate[] = [];
  @state() private outgoingLandAttacks: AttackUpdate[] = [];
  @state() private outgoingBoats: UnitView[] = [];
  @state() private incomingBoats: UnitView[] = [];
  @state()
  private outgoingAttackAnchors: Map<string, { x: number; y: number } | null> =
    new Map();
  @state()
  private outgoingAttackCancelAnchors: Map<
    string,
    { x: number; y: number } | null
  > = new Map();
  private outgoingAttackAngles: Map<string, number> = new Map();
  private pendingOutgoingAnchorLookups: Set<string> = new Set();
  private outgoingAttackAnchorRefreshTick: Map<string, number> = new Map();
  private outgoingAttackRawAnchors: Map<string, { x: number; y: number }> =
    new Map();
  private outgoingAttackJitterScore: Map<string, number> = new Map();
  private outgoingAttackCenterMode: Map<string, boolean> = new Map();

  createRenderRoot() {
    return this;
  }

  init() {}

  tick() {
    this.active = true;

    if (!this._isVisible && !this.game.inSpawnPhase()) {
      this._isVisible = true;
    }

    const myPlayer = this.game.myPlayer();
    if (!myPlayer || !myPlayer.isAlive()) {
      if (this._isVisible) {
        this._isVisible = false;
      }
      return;
    }

    // Track incoming boat unit IDs from UnitIncoming events
    const updates = this.game.updatesSinceLastTick();
    if (updates) {
      for (const event of updates[
        GameUpdateType.UnitIncoming
      ] as UnitIncomingUpdate[]) {
        if (
          event.playerID === myPlayer.smallID() &&
          event.messageType === MessageType.NAVAL_INVASION_INBOUND
        ) {
          this.incomingBoatIDs.add(event.unitID);
        }
      }
    }

    // Resolve incoming boats from tracked IDs, remove inactive ones
    const resolvedIncomingBoats: UnitView[] = [];
    for (const unitID of this.incomingBoatIDs) {
      const unit = this.game.unit(unitID);
      if (unit && unit.isActive() && unit.type() === UnitType.TransportShip) {
        resolvedIncomingBoats.push(unit);
      } else {
        this.incomingBoatIDs.delete(unitID);
      }
    }
    this.incomingBoats = resolvedIncomingBoats;

    this.incomingAttacks = myPlayer.incomingAttacks().filter((a) => {
      const t = (this.game.playerBySmallID(a.attackerID) as PlayerView).type();
      return t !== PlayerType.Bot;
    });

    this.outgoingAttacks = myPlayer
      .outgoingAttacks()
      .filter((a) => a.targetID !== 0);
    this.refreshOutgoingAttackAnchors(this.outgoingAttacks);

    this.outgoingLandAttacks = myPlayer
      .outgoingAttacks()
      .filter((a) => a.targetID === 0);

    this.outgoingBoats = myPlayer
      .units()
      .filter((u) => u.type() === UnitType.TransportShip);

    this.requestUpdate();
  }

  shouldTransform(): boolean {
    return false;
  }

  renderLayer(): void {
    if (this.transform?.hasChanged()) {
      this.requestUpdate();
    }
  }

  private refreshOutgoingAttackAnchors(attacks: AttackUpdate[]) {
    const activeIds = new Set(attacks.map((a) => a.id));
    const currentTick = this.game.ticks();

    for (const id of Array.from(this.outgoingAttackAnchors.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackAnchors.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackCancelAnchors.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackCancelAnchors.delete(id);
    }
    for (const id of Array.from(this.pendingOutgoingAnchorLookups)) {
      if (!activeIds.has(id)) this.pendingOutgoingAnchorLookups.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackAngles.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackAngles.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackAnchorRefreshTick.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackAnchorRefreshTick.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackRawAnchors.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackRawAnchors.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackJitterScore.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackJitterScore.delete(id);
    }
    for (const id of Array.from(this.outgoingAttackCenterMode.keys())) {
      if (!activeIds.has(id)) this.outgoingAttackCenterMode.delete(id);
    }

    for (const attack of attacks) {
      if (!this.outgoingAttackAngles.has(attack.id)) {
        this.outgoingAttackAngles.set(
          attack.id,
          this.getOutgoingAttackMarkerAngle(attack),
        );
      }
      if (this.pendingOutgoingAnchorLookups.has(attack.id)) continue;

      const hasAnchor = this.outgoingAttackAnchors.has(attack.id);
      const lastRefreshTick =
        this.outgoingAttackAnchorRefreshTick.get(attack.id) ?? -Infinity;
      const shouldRefresh = !hasAnchor || currentTick - lastRefreshTick >= 3;
      if (!shouldRefresh) continue;

      this.outgoingAttackAnchorRefreshTick.set(attack.id, currentTick);
      this.resolveOutgoingAttackAnchor(attack);
    }
  }

  private async resolveOutgoingAttackAnchor(attack: AttackUpdate) {
    this.pendingOutgoingAnchorLookups.add(attack.id);
    try {
      const attacker = this.game.playerBySmallID(attack.attackerID);
      if (!(attacker instanceof PlayerView)) {
        this.outgoingAttackAnchors.set(attack.id, null);
        return;
      }

      const averagePosition = await attacker.attackAveragePosition(
        attack.attackerID,
        attack.id,
      );

      if (averagePosition === null) {
        this.outgoingAttackAnchors.set(attack.id, null);
      } else {
        const raw = { x: averagePosition.x, y: averagePosition.y };
        const prevRaw = this.outgoingAttackRawAnchors.get(attack.id);
        this.outgoingAttackRawAnchors.set(attack.id, raw);

        const delta =
          prevRaw === undefined
            ? 0
            : Math.hypot(raw.x - prevRaw.x, raw.y - prevRaw.y);
        const prevJitter = this.outgoingAttackJitterScore.get(attack.id) ?? 0;
        const jitter = prevJitter * 0.82 + delta * 0.18;
        this.outgoingAttackJitterScore.set(attack.id, jitter);

        const target = this.game.playerBySmallID(attack.targetID);
        const targetView =
          target instanceof PlayerView ? (target as PlayerView) : undefined;
        const largeTarget = (targetView?.numTilesOwned() ?? 0) >= 150_000;

        let centerMode = this.outgoingAttackCenterMode.get(attack.id) ?? false;
        if (largeTarget || jitter > 9.5) centerMode = true;
        else if (!largeTarget && jitter < 4.0) centerMode = false;
        this.outgoingAttackCenterMode.set(attack.id, centerMode);

        if (centerMode && targetView?.nameLocation()) {
          this.outgoingAttackAnchors.set(attack.id, {
            x: targetView.nameLocation().x,
            y: targetView.nameLocation().y,
          });
        } else {
          const prevAnchor = this.outgoingAttackAnchors.get(attack.id);
          const nextAnchor =
            prevAnchor === null || prevAnchor === undefined
              ? raw
              : {
                  // Smooth follow: keeps border tracking readable during fast movement.
                  x: prevAnchor.x * 0.68 + raw.x * 0.32,
                  y: prevAnchor.y * 0.68 + raw.y * 0.32,
                };
          this.outgoingAttackAnchors.set(attack.id, nextAnchor);
        }

        if (!this.outgoingAttackCancelAnchors.has(attack.id)) {
          this.outgoingAttackCancelAnchors.set(attack.id, {
            x: averagePosition.x,
            y: averagePosition.y,
          });
        }
      }
    } catch {
      this.outgoingAttackAnchors.set(attack.id, null);
      if (!this.outgoingAttackCancelAnchors.has(attack.id)) {
        this.outgoingAttackCancelAnchors.set(attack.id, null);
      }
    } finally {
      this.pendingOutgoingAnchorLookups.delete(attack.id);
      this.requestUpdate();
    }
  }

  private renderButton(options: {
    content: any;
    onClick?: () => void;
    className?: string;
    disabled?: boolean;
    translate?: boolean;
    hidden?: boolean;
  }) {
    const {
      content,
      onClick,
      className = "",
      disabled = false,
      translate = true,
      hidden = false,
    } = options;

    if (hidden) {
      return html``;
    }

    return html`
      <button
        class="${className}"
        @click=${onClick}
        ?disabled=${disabled}
        ?translate=${translate}
      >
        ${content}
      </button>
    `;
  }

  private emitCancelAttackIntent(id: string) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    this.eventBus.emit(new CancelAttackIntentEvent(id));
  }

  private emitBoatCancelIntent(id: number) {
    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;
    this.eventBus.emit(new CancelBoatIntentEvent(id));
  }

  private emitGoToPlayerEvent(attackerID: number) {
    const attacker = this.game.playerBySmallID(attackerID) as PlayerView;
    this.eventBus.emit(new GoToPlayerEvent(attacker));
  }

  private getBoatSpriteDataURL(unit: UnitView): string {
    const owner = unit.owner();
    const key = `boat-${owner.id()}`;
    const cached = this.spriteDataURLCache.get(key);
    if (cached) return cached;
    try {
      const canvas = getColoredSprite(unit, this.game.config().theme());
      const dataURL = canvas.toDataURL();
      this.spriteDataURLCache.set(key, dataURL);
      return dataURL;
    } catch {
      return "";
    }
  }

  private async attackWarningOnClick(attack: AttackUpdate) {
    const playerView = this.game.playerBySmallID(attack.attackerID);
    if (playerView !== undefined) {
      if (playerView instanceof PlayerView) {
        const averagePosition = await playerView.attackAveragePosition(
          attack.attackerID,
          attack.id,
        );

        if (averagePosition === null) {
          this.emitGoToPlayerEvent(attack.attackerID);
        } else {
          this.eventBus.emit(
            new GoToPositionEvent(averagePosition.x, averagePosition.y),
          );
        }
      }
    } else {
      this.emitGoToPlayerEvent(attack.attackerID);
    }
  }

  private handleRetaliate(attack: AttackUpdate) {
    const attacker = this.game.playerBySmallID(attack.attackerID) as PlayerView;
    if (!attacker) return;

    const myPlayer = this.game.myPlayer();
    if (!myPlayer) return;

    const counterTroops = Math.min(
      attack.troops,
      this.uiState.attackRatio * myPlayer.troops(),
    );
    this.eventBus.emit(new SendAttackIntentEvent(attacker.id(), counterTroops));
  }

  private renderIncomingAttacks() {
    if (this.incomingAttacks.length === 0) return html``;

    return this.incomingAttacks.map(
      (attack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/70 backdrop-blur-xs sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(27%) sepia(91%) saturate(4551%) hue-rotate(348deg) brightness(89%) contrast(97%)"
                />↓</span
              ><span class="ml-1">${renderTroops(attack.troops)}</span>
              <span class="truncate ml-1"
                >${(
                  this.game.playerBySmallID(attack.attackerID) as PlayerView
                )?.name()}</span
              >
              ${attack.retreating
                ? `(${translateText("events_display.retreating")}...)`
                : ""} `,
            onClick: () => this.attackWarningOnClick(attack),
            className:
              "text-left text-red-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${!attack.retreating
            ? this.renderButton({
                content: html`<img
                  src="${swordIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(27%) sepia(91%) saturate(4551%) hue-rotate(348deg) brightness(89%) contrast(97%)"
                />`,
                onClick: () => this.handleRetaliate(attack),
                className:
                  "ml-auto inline-flex items-center justify-center cursor-pointer bg-red-900/50 hover:bg-red-800/70 sm:rounded-lg px-1.5 py-1 border border-red-700/50",
                translate: false,
              })
            : ""}
        </div>
      `,
    );
  }

  private renderOutgoingAttacks() {
    if (this.outgoingAttacks.length === 0) return html``;

    return this.outgoingAttacks.map(
      (attack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/70 backdrop-blur-xs sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(62%) sepia(80%) saturate(500%) hue-rotate(175deg) brightness(100%)"
                />↑</span
              ><span class="ml-1">${renderTroops(attack.troops)}</span>
              <span class="truncate ml-1"
                >${(
                  this.game.playerBySmallID(attack.targetID) as PlayerView
                )?.name()}</span
              > `,
            onClick: async () => this.attackWarningOnClick(attack),
            className:
              "text-left text-sky-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${!attack.retreating
            ? this.renderButton({
                content: "❌",
                onClick: () => this.emitCancelAttackIntent(attack.id),
                className: "ml-auto text-left shrink-0",
                disabled: attack.retreating,
              })
            : html`<span class="ml-auto truncate text-blue-400"
                >(${translateText("events_display.retreating")}...)</span
              >`}
        </div>
      `,
    );
  }

  private renderOutgoingLandAttacks() {
    if (this.outgoingLandAttacks.length === 0) return html``;

    return this.outgoingLandAttacks.map(
      (landAttack) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/70 backdrop-blur-xs sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`<span class="inline-flex items-center"
                ><img
                  src="${soldierIcon}"
                  class="h-4 w-4"
                  style="filter: brightness(0) saturate(100%) invert(62%) sepia(80%) saturate(500%) hue-rotate(175deg) brightness(100%)"
                />↑</span
              ><span class="ml-1">${renderTroops(landAttack.troops)}</span>
              ${translateText("help_modal.ui_wilderness")}`,
            className:
              "text-left text-sky-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${!landAttack.retreating
            ? this.renderButton({
                content: "❌",
                onClick: () => this.emitCancelAttackIntent(landAttack.id),
                className: "ml-auto text-left shrink-0",
                disabled: landAttack.retreating,
              })
            : html`<span class="ml-auto truncate text-blue-400"
                >(${translateText("events_display.retreating")}...)</span
              >`}
        </div>
      `,
    );
  }

  private getBoatTargetName(boat: UnitView): string {
    const target = boat.targetTile();
    if (target === undefined) return "";
    const ownerID = this.game.ownerID(target);
    if (ownerID === 0) return "";
    const player = this.game.playerBySmallID(ownerID) as PlayerView;
    return player?.name() ?? "";
  }

  private renderBoatIcon(boat: UnitView) {
    const dataURL = this.getBoatSpriteDataURL(boat);
    if (!dataURL) return html``;
    return html`<img
      src="${dataURL}"
      class="h-5 w-5 inline-block"
      style="image-rendering: pixelated"
    />`;
  }

  private renderBoats() {
    if (this.outgoingBoats.length === 0) return html``;

    return this.outgoingBoats.map(
      (boat) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/70 backdrop-blur-xs sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`${this.renderBoatIcon(boat)}
              <span class="inline-block min-w-[3rem] text-right"
                >${renderTroops(boat.troops())}</span
              >
              <span class="truncate text-xs ml-1"
                >${this.getBoatTargetName(boat)}</span
              >`,
            onClick: () => this.eventBus.emit(new GoToUnitEvent(boat)),
            className:
              "text-left text-blue-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
          ${!boat.retreating()
            ? this.renderButton({
                content: "❌",
                onClick: () => this.emitBoatCancelIntent(boat.id()),
                className: "ml-auto text-left shrink-0",
                disabled: boat.retreating(),
              })
            : html`<span class="ml-auto truncate text-blue-400"
                >(${translateText("events_display.retreating")}...)</span
              >`}
        </div>
      `,
    );
  }

  private renderIncomingBoats() {
    if (this.incomingBoats.length === 0) return html``;

    return this.incomingBoats.map(
      (boat) => html`
        <div
          class="flex items-center gap-0.5 w-full bg-gray-800/70 backdrop-blur-xs sm:rounded-lg px-1.5 py-0.5 overflow-hidden"
        >
          ${this.renderButton({
            content: html`${this.renderBoatIcon(boat)}
              <span class="inline-block min-w-[3rem] text-right"
                >${renderTroops(boat.troops())}</span
              >
              <span class="truncate text-xs ml-1"
                >${boat.owner()?.name()}</span
              >`,
            onClick: () => this.eventBus.emit(new GoToUnitEvent(boat)),
            className:
              "text-left text-red-400 inline-flex items-center gap-0.5 lg:gap-1 min-w-0",
            translate: false,
          })}
        </div>
      `,
    );
  }

  private getOutgoingAttackAnchor(
    attack: AttackUpdate,
  ): { x: number; y: number } | null {
    return this.outgoingAttackAnchors.get(attack.id) ?? null;
  }

  private getOutgoingAttackCancelAnchor(
    attack: AttackUpdate,
  ): { x: number; y: number } | null {
    return this.outgoingAttackCancelAnchors.get(attack.id) ?? null;
  }

  private getOutgoingAttackMarkerAngle(attack: AttackUpdate): number {
    const me = this.game.myPlayer();
    const target = this.game.playerBySmallID(attack.targetID) as
      | PlayerView
      | undefined;
    const meCenter = me?.nameLocation();
    const targetCenter = target?.nameLocation();
    if (!meCenter || !targetCenter) return -18;

    const dx = targetCenter.x - meCenter.x;
    const dy = targetCenter.y - meCenter.y;

    if (Math.abs(dx) <= Math.abs(dy) * 0.45) return -8;
    const sameDiagonal = (dx < 0 && dy < 0) || (dx > 0 && dy > 0);
    return sameDiagonal ? -20 : 20;
  }

  private renderOutgoingAttackMarkers() {
    if (!this.transform || this.outgoingAttacks.length === 0) {
      return html``;
    }

    const myTerritoryColor =
      this.game.myPlayer()?.territoryColor().toHex() ?? "#7dd3fc";

    const labelMarkers = this.outgoingAttacks
      .map((attack) => {
        const anchor = this.getOutgoingAttackAnchor(attack);
        if (!anchor) return null;

        const worldCell = new Cell(anchor.x, anchor.y);
        if (!this.transform!.isOnScreen(worldCell)) return null;
        const screen = this.transform!.worldToScreenCoordinates(worldCell);

        const centerMode = this.outgoingAttackCenterMode.get(attack.id) ?? false;
        const angle = centerMode
          ? 0
          : this.outgoingAttackAngles.get(attack.id) ?? -18;
        const markerColor = attack.retreating ? "#9ca3af" : myTerritoryColor;

        if (centerMode) {
          return html`
            <div
              class="fixed z-[75] pointer-events-none select-none tabular-nums leading-none font-extrabold text-[14px] lg:text-[16px]"
              style="left:${screen.x.toFixed(2)}px; top:${screen.y.toFixed(
                2,
              )}px; transform: translate(-50%, -50%); color: ${markerColor};"
              translate="no"
            >
              <span
                class="inline-flex items-center justify-center rounded-full px-2 py-1 min-w-[3.25rem]"
                style="background: rgba(15,23,42,0.62); border: 1px solid ${markerColor}; -webkit-text-stroke: 0.45px rgba(0,0,0,0.85); text-shadow: -0.6px -0.6px 0 rgba(0,0,0,0.7), 0.6px -0.6px 0 rgba(0,0,0,0.7), -0.6px 0.6px 0 rgba(0,0,0,0.7), 0.6px 0.6px 0 rgba(0,0,0,0.7);"
                >${renderTroops(attack.troops)}</span
              >
            </div>
          `;
        }

        return html`
          <div
            class="fixed z-[75] pointer-events-none select-none tabular-nums leading-none font-extrabold italic text-[14px] lg:text-[16px] opacity-95"
            style="left:${screen.x.toFixed(2)}px; top:${screen.y.toFixed(
              2,
            )}px; transform: translate(-50%, -48%) rotate(${angle}deg); color: ${markerColor}; opacity: 0.92; -webkit-text-stroke: 0.55px rgba(0,0,0,0.82); text-shadow: -0.7px -0.7px 0 rgba(0,0,0,0.7), 0.7px -0.7px 0 rgba(0,0,0,0.7), -0.7px 0.7px 0 rgba(0,0,0,0.7), 0.7px 0.7px 0 rgba(0,0,0,0.7), 0 1px 3px rgba(0,0,0,0.35);"
            translate="no"
          >
            ${renderTroops(attack.troops)}
          </div>
        `;
      })
      .filter((x) => x !== null);

    const cancelMarkers = this.outgoingAttacks
      .map((attack) => {
        const cancelAnchor = this.getOutgoingAttackCancelAnchor(attack);
        if (!cancelAnchor) return null;

        const worldCell = new Cell(cancelAnchor.x, cancelAnchor.y);
        if (!this.transform!.isOnScreen(worldCell)) return null;
        const screen = this.transform!.worldToScreenCoordinates(worldCell);

        const markerColor = attack.retreating ? "#9ca3af" : myTerritoryColor;

        return html`
          <button
            class="fixed z-[76] pointer-events-auto select-none inline-flex items-center gap-0.5 p-0.5 disabled:opacity-45 disabled:cursor-default"
            style="left:${screen.x.toFixed(2)}px; top:${screen.y.toFixed(
              2,
            )}px; transform: translate(-50%, -50%); background: transparent; border: none;"
            translate="no"
            @click=${() => this.emitCancelAttackIntent(attack.id)}
            ?disabled=${attack.retreating}
            title="Cancel attack"
          >
            <svg
              viewBox="0 0 24 24"
              class="h-4 w-4 lg:h-5 lg:w-5"
              style="overflow: visible;"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="7"
                r="3.8"
                fill="${markerColor}"
                stroke="rgba(0,0,0,0.9)"
                stroke-width="1.4"
              ></circle>
              <path
                d="M4.2 21c0-4.1 3.5-6.9 7.8-6.9s7.8 2.8 7.8 6.9"
                fill="${markerColor}"
                stroke="rgba(0,0,0,0.9)"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              ></path>
            </svg>
            <span
              class="text-[11px] lg:text-[12px] font-black leading-none"
              style="color: #ef4444; text-shadow: -0.6px -0.6px 0 rgba(0,0,0,0.9), 0.6px -0.6px 0 rgba(0,0,0,0.9), -0.6px 0.6px 0 rgba(0,0,0,0.9), 0.6px 0.6px 0 rgba(0,0,0,0.9);"
              >↩</span
            >
          </button>
        `;
      })
      .filter((x) => x !== null);

    return html`${labelMarkers}${cancelMarkers}`;
  }

  render() {
    if (!this.active || !this._isVisible) {
      return html``;
    }

    const hasAnything =
      this.outgoingAttacks.length > 0 ||
      this.outgoingLandAttacks.length > 0 ||
      this.outgoingBoats.length > 0 ||
      this.incomingAttacks.length > 0 ||
      this.incomingBoats.length > 0;

    if (!hasAnything) {
      return html``;
    }

    return html`
      ${this.renderOutgoingAttackMarkers()}
      <div
        class="w-full mb-1 mt-1 sm:mt-0 pointer-events-auto grid grid-cols-2 gap-1 text-white text-sm lg:text-base max-h-[7rem] overflow-y-auto"
      >
        ${this.renderOutgoingLandAttacks()} ${this.renderBoats()}
        ${this.renderIncomingAttacks()} ${this.renderIncomingBoats()}
      </div>
    `;
  }
}
