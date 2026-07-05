import { useEffect, useRef, useState } from 'react';
import { createShelfDesigner, PRODUCTS } from '../scenes/shelfDesigner.js';

export default function ShelfDesigner() {
  const stageRef = useRef(null);
  const ctrlRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [moveMode, setMoveMode] = useState(false);
  const [selected, setSelected] = useState(null);
  const [state, setState] = useState({ placed: 0, total: 0, shelves: [], limits: null });

  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;
    setLoading(true);
    let ctrl = null;
    const id = requestAnimationFrame(() => {
      ctrl = createShelfDesigner(container, { onChange: setState, onSelect: setSelected });
      ctrlRef.current = ctrl;
      setLoading(false);
    });
    return () => {
      cancelAnimationFrame(id);
      ctrl?.dispose();
      ctrlRef.current = null;
    };
  }, []);

  // ----- palette drag source -----
  const onDragStart = (e, id) => {
    e.dataTransfer.setData('text/product', id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  // ----- canvas drop target -----
  const onDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    ctrlRef.current?.hoverAt(e.clientX, e.clientY);
  };
  const onDragLeave = () => ctrlRef.current?.clearHover();
  const onDrop = (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/product');
    const def = PRODUCTS.find((p) => p.id === id);
    if (def) ctrlRef.current?.dropAt(e.clientX, e.clientY, def);
  };

  // ----- shelf layout controls -----
  const ctrl = () => ctrlRef.current;
  const limits = state.limits;
  const canAddShelf = limits ? state.shelves.length < limits.maxShelves : true;

  const toggleMove = () => {
    const next = !moveMode;
    setMoveMode(next);
    ctrl()?.setMoveMode(next);
  };

  return (
    <div className="designer">
      <aside className="palette">
        <div className="palette-title">Products</div>
        <p className="palette-hint">
          {moveMode ? 'Locked — exit Move shelves to place' : 'Drag onto a shelf slot'}
        </p>
        <div className={`palette-grid${moveMode ? ' palette-grid--locked' : ''}`}>
          {PRODUCTS.map((p) => (
            <div
              key={p.id}
              className="chip"
              draggable={!moveMode}
              onDragStart={(e) => onDragStart(e, p.id)}
              title={`Drag ${p.name} onto a shelf slot`}
            >
              <span className="swatch" style={{ background: p.color }} />
              <span className="chip-name">{p.name}</span>
            </div>
          ))}
        </div>

        <div className="palette-meta">
          <span>{state.placed} / {state.total} slots filled</span>
        </div>

        {/* ----- shelf builder ----- */}
        <div className="section-head">
          <span className="palette-title">Shelves</span>
          <div className="section-actions">
            <button
              className={`btn btn-sm${moveMode ? ' btn-active' : ''}`}
              onClick={toggleMove}
              title="Drag shelf units around the floor"
            >
              {moveMode ? '✓ Moving' : 'Move'}
            </button>
            <button
              className="btn btn-sm"
              onClick={() => ctrl()?.addShelf()}
              disabled={!canAddShelf}
              title={canAddShelf ? 'Add a new shelf unit' : 'Maximum shelves reached'}
            >
              + Shelf
            </button>
          </div>
        </div>

        <div className="shelf-list">
          {state.shelves.map((shelf, si) => (
            <div
              className={`shelf-card${selected?.kind === 'shelf' && selected.id === shelf.id ? ' is-active' : ''}`}
              key={shelf.id}
            >
              <div className="shelf-card-head">
                <button
                  className="shelf-name"
                  onClick={(e) => ctrl()?.inspectShelf(shelf.id, e.clientX, e.clientY)}
                  title="Click to inspect this shelf"
                >
                  Shelf {si + 1}
                </button>
                <button
                  className="btn-x"
                  onClick={() => ctrl()?.removeShelf(shelf.id)}
                  title="Remove this shelf"
                >
                  ✕
                </button>
              </div>

              <div className="deck-row deck-row--depth">
                <span className="deck-label">Depth</span>
                <div className="stepper" title="Shelf depth (front-to-back size)">
                  <button
                    className="step"
                    onClick={() => ctrl()?.setShelfDepth(shelf.id, shelf.depth - (limits?.depthStep || 0.5))}
                    disabled={limits && shelf.depth <= limits.minDepth}
                  >
                    −
                  </button>
                  <span className="step-val">{shelf.depth.toFixed(1)}</span>
                  <button
                    className="step"
                    onClick={() => ctrl()?.setShelfDepth(shelf.id, shelf.depth + (limits?.depthStep || 0.5))}
                    disabled={limits && shelf.depth >= limits.maxDepth}
                  >
                    +
                  </button>
                </div>
              </div>

              {shelf.decks.map((deck, di) => (
                <div className="deck-row" key={di}>
                  <span className="deck-label">Deck {di + 1}</span>
                  <div className="stepper" title="Slots on this deck (slot width)">
                    <button
                      className="step"
                      onClick={() => ctrl()?.setDeckCols(shelf.id, di, deck.cols - 1)}
                      disabled={limits && deck.cols <= limits.minCols}
                    >
                      −
                    </button>
                    <span className="step-val">{deck.cols}</span>
                    <button
                      className="step"
                      onClick={() => ctrl()?.setDeckCols(shelf.id, di, deck.cols + 1)}
                      disabled={limits && deck.cols >= limits.maxCols}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}

              <div className="deck-actions">
                <button
                  className="btn btn-sm"
                  onClick={() => ctrl()?.addDeck(shelf.id)}
                  disabled={limits && shelf.decks.length >= limits.maxDecks}
                >
                  + Deck
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => ctrl()?.removeDeck(shelf.id)}
                  disabled={limits && shelf.decks.length <= limits.minDecks}
                >
                  − Deck
                </button>
              </div>
            </div>
          ))}
        </div>

        <button className="btn" onClick={() => ctrl()?.clear()}>Clear products</button>

        <ul className="tips">
          <li>Drag a product → drop on a slot</li>
          <li>Drag a placed item to move it</li>
          <li>Drag it below the shelf to remove</li>
          <li>Double-click an item to delete</li>
          <li>+ Slot / − Slot resizes a deck's cells</li>
          <li>Depth − / + sets a shelf's front-to-back size</li>
          <li>Move → drag whole shelves around the floor</li>
          <li>Move → drag a shelf's ring to rotate it</li>
          <li>Click a product or shelf to inspect it</li>
          <li>Click a shelf's name in the list to inspect it</li>
        </ul>
      </aside>

      <div
        className="stage stage--designer"
        ref={stageRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className={`loading${loading ? '' : ' hidden'}`}>Building shelf…</div>
      </div>

      {selected && (
        <DetailCard
          sel={selected}
          onClose={() => { ctrl()?.deselect(); setSelected(null); }}
        />
      )}
    </div>
  );
}

// floating detail card pinned near the cursor where the user clicked
function DetailCard({ sel, onClose }) {
  // keep the card on-screen even when clicking near the right/bottom edge
  const left = Math.min(sel.x + 16, window.innerWidth - 230);
  const top = Math.min(sel.y + 16, window.innerHeight - 180);

  return (
    <div className="detail-card" style={{ left, top }}>
      <button className="detail-close" onClick={onClose} title="Close">✕</button>

      {sel.kind === 'product' ? (
        <>
          <div className="detail-head">
            <span className="swatch" style={{ background: sel.color }} />
            <span className="detail-title">{sel.name}</span>
          </div>
          <dl className="detail-rows">
            <dt>Type</dt><dd>{sel.shape}</dd>
            <dt>Size&nbsp;(w×h×d)</dt>
            <dd>{sel.dims.w} × {sel.dims.h} × {sel.dims.d}</dd>
            <dt>Color</dt><dd>{sel.color}</dd>
            <dt>Location</dt>
            <dd>
              {sel.location
                ? `Shelf ${sel.location.shelf} · Deck ${sel.location.deck} · Slot ${sel.location.col}`
                : 'Unplaced'}
            </dd>
          </dl>
        </>
      ) : (
        <>
          <div className="detail-head">
            <span className="detail-title">Shelf {sel.index}</span>
          </div>
          <dl className="detail-rows">
            <dt>Decks</dt><dd>{sel.decks.length}</dd>
            <dt>Depth</dt><dd>{sel.depth}</dd>
            <dt>Slots / deck</dt><dd>{sel.decks.join(' · ')}</dd>
            <dt>Filled</dt><dd>{sel.filled} / {sel.total}</dd>
            <dt>Position&nbsp;(x,z)</dt><dd>{sel.pos.x}, {sel.pos.z}</dd>
            <dt>Rotation</dt><dd>{sel.rot}°</dd>
          </dl>
        </>
      )}
    </div>
  );
}
