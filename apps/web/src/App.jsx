import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ThreeScene from './components/ThreeScene.jsx';
import ShelfDesigner from './components/ShelfDesigner.jsx';
import Dashboard from './components/Dashboard.jsx';
import { createLogisticsScene } from './scenes/logistics.js';
import { createSmartShelfScene } from './scenes/smartShelf.js';
import { createSmartStoreScene } from './scenes/smartStore.js';
import { createSmartStoreBabylonScene } from './scenes/smartStoreBabylon.js';

const VERSIONS = {
  v1: {
    factory: createLogisticsScene,
    title: 'Smart Logistics Network',
    sub: 'Real-time supply chain · drag to orbit · scroll to zoom',
    docTitle: 'Smart Logistics Network',
  },
  v2: {
    factory: createSmartShelfScene,
    title: 'Smart Shelf · Live Aisle',
    sub: 'Customer tracking active · drag to orbit · scroll to zoom',
    docTitle: 'Smart Shelf · Live Aisle',
  },
  v3: {
    designer: true,
    title: 'Shelf Designer',
    sub: 'Drag products from the palette onto the 3D shelf',
    docTitle: 'Shelf Designer',
  },
  v4: {
    dashboard: true,
    sceneFactory: createSmartStoreScene,
    title: 'Smart Shelf Dashboard',
    sub: 'Intelligent retail solution',
    docTitle: 'Smart Shelf Dashboard',
  },
  v5: {
    dashboard: true,
    // Babylon's synchronous scene build blocks for seconds — boot behind a
    // loading overlay instead of freezing the first paint (V4 stays instant).
    deferScene: true,
    sceneFactory: createSmartStoreBabylonScene,
    title: 'Smart Shelf Dashboard',
    sub: 'Babylon.js engine',
    docTitle: 'Smart Shelf Dashboard · Babylon',
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
        <Route path="*" element={<Navigate to={`/${DEFAULT_VERSION}`} replace />} />
      </Routes>
    </BrowserRouter>
  );
}
