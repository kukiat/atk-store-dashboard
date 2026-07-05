import { useEffect, useRef, useState } from 'react';

/**
 * Mounts an imperative Three.js scene into a container div.
 * `factory` is `(container) => disposeFn`.
 * Remounts whenever `factory` changes (i.e. when switching versions).
 */
export default function ThreeScene({ factory }) {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    setLoading(true);

    let dispose = () => {};
    // defer one frame so the container has its layout size
    const id = requestAnimationFrame(() => {
      dispose = factory(container);
      setLoading(false);
    });

    return () => {
      cancelAnimationFrame(id);
      dispose();
    };
  }, [factory]);

  return (
    <div className="stage" ref={ref}>
      <div className={`loading${loading ? '' : ' hidden'}`}>Initializing scene…</div>
    </div>
  );
}
