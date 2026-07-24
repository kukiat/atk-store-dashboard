import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ThreeScene from './components/ThreeScene.jsx';
import ShelfDesigner from './components/ShelfDesigner.jsx';
import Dashboard from './components/Dashboard.jsx';
import Backdoor from './components/Backdoor.jsx';
import { createLogisticsScene } from './scenes/logistics.js';
import { createSmartShelfScene } from './scenes/smartShelf.js';
import { createSmartStoreBabylonScene } from './scenes/smartStoreBabylon.js';
// NB scenes/smartStore.js (the retired Three.js V4 stage) is intentionally
// kept on disk unimported — it is the layout/design/color reference for a
// possible future "V4 theme" on V5.

const VERSIONS = {
  v1: {
    factory: createLogisticsScene,
    title: 'Smart Logistics Network',
    sub: 'Real-time supply chain · drag to orbit · scroll to zoom',
    docTitle: 'Smart Logistics Network · ATK Store',
  },
  v2: {
    factory: createSmartShelfScene,
    title: 'Smart Shelf · Live Aisle',
    sub: 'Customer tracking active · drag to orbit · scroll to zoom',
    docTitle: 'Smart Shelf · ATK Store',
  },
  v3: {
    designer: true,
    title: 'Shelf DesignerXXXX',
    sub: 'Drag products from the palette onto the 3D shelf',
    docTitle: 'Shelf Designer · ATK Store',
  },
  v5: {
    dashboard: true,
    // Babylon's synchronous scene build blocks for seconds — boot behind a
    // loading overlay instead of freezing the first paint (V4 stays instant).
    deferScene: true,
    sceneFactory: createSmartStoreBabylonScene,
    title: 'Smart Shelf Dashboard',
    sub: 'Babylon.js engine',
    docTitle: 'ATK Store Dashboard',
  },
};

const DEFAULT_VERSION = 'v5';

function VersionPage({ id }) {
  const v = VERSIONS[id];

  useEffect(() => {
    document.title = v.docTitle;
  }, [v]);

  return (
    <>
      {!v.designer && !v.dashboard && (
        <div className="hud">
          <h1>{v.title}</h1>
          <p>{v.sub}</p>
        </div>
      )}

      {v.dashboard ? (
        <Dashboard key={id} sceneFactory={v.sceneFactory} deferScene={!!v.deferScene} />
      ) : v.designer ? (
        <ShelfDesigner key={id} />
      ) : (
        <ThreeScene key={id} factory={v.factory} />
      )}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={`/${DEFAULT_VERSION}`} replace />} />
        {Object.keys(VERSIONS).map((id) => (
          <Route key={id} path={`/${id}`} element={<VersionPage id={id} />} />
        ))}
        {/* hidden operator backdoor — not a 3D "version", so it lives outside
            VERSIONS and nothing links to it (type /backdoor by hand). */}
        <Route path="/backdoor" element={<Backdoor />} />
        <Route path="*" element={<Navigate to={`/${DEFAULT_VERSION}`} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
