// Retarget the Quaternius shopper clips (Idle / Walk / PickUp) onto a Mixamo
// skeleton so a Mixamo-rigged character (public/models/character.glb) can join
// the crowd with the exact motion the rest of the shoppers use.
//
// The two rigs are different: Quaternius has 23 short-named bones (Fist.R,
// UpperArm.R, Abdomen…) and ships the clips; the Mixamo rig has 43 mixamorig_*
// bones (plus fingers/toes/eyes) and ZERO clips. Their bind poses differ, so we
// can't copy local rotations — we retarget in MODEL space: for each mapped bone
// we take the source bone's world-rotation delta from ITS rest pose and apply it
// to the target bone's own rest pose, then convert back to a local rotation.
// This is bind-pose-agnostic and also absorbs the fact that Quaternius parents
// the IK feet under the armature root rather than under the shins.
//
// Babylon's quaternion composition order (worldQ = localQ*parentQ, or the
// reverse) depends on internal convention, so instead of hard-coding it we
// DETECT it from the loaded rig (compareCompositionOrder) and derive every other
// multiply from that one fact. The bake runs once per file at load; clones made
// by instantiateModelsToScene inherit the synthesized AnimationGroups.

import { Quaternion, Vector3, Animation, AnimationGroup } from '@babylonjs/core';

// Quaternius bone -> Mixamo bone. Only these drive the retarget; unmapped Mixamo
// bones (fingers, toes, eyes, Spine1) keep their rest pose and simply follow.
export const RETARGET_MAP = {
  Hips: 'mixamorig_Hips',
  Abdomen: 'mixamorig_Spine',
  Torso: 'mixamorig_Spine2',
  Neck: 'mixamorig_Neck',
  Head: 'mixamorig_Head',
  'Shoulder.L': 'mixamorig_LeftShoulder',
  'UpperArm.L': 'mixamorig_LeftArm',
  'LowerArm.L': 'mixamorig_LeftForeArm',
  'Fist.L': 'mixamorig_LeftHand',
  'Shoulder.R': 'mixamorig_RightShoulder',
  'UpperArm.R': 'mixamorig_RightArm',
  'LowerArm.R': 'mixamorig_RightForeArm',
  'Fist.R': 'mixamorig_RightHand',
  'UpperLeg.L': 'mixamorig_LeftUpLeg',
  'LowerLeg.L': 'mixamorig_LeftLeg',
  'Foot.L': 'mixamorig_LeftFoot',
  'UpperLeg.R': 'mixamorig_RightUpLeg',
  'LowerLeg.R': 'mixamorig_RightLeg',
  'Foot.R': 'mixamorig_RightFoot',
};

const CLIPS = ['Idle', 'Walk', 'PickUp'];

// Bones where the two rigs bind DIFFERENTLY: Quaternius binds the arms down at
// the sides (A-pose) while Mixamo binds them straight out (T-pose). A delta
// retarget keeps each rig's own rest, so on Mixamo the arms would stay splayed
// out with only the small walk-swing added. For these we match the source bone's
// ABSOLUTE world orientation instead, so the Mixamo arms adopt the crowd's
// arms-down pose. Legs/spine/neck share a rest direction, so they use delta.
const ABSOLUTE_BONES = new Set([
  'Shoulder.L', 'UpperArm.L', 'LowerArm.L', 'Fist.L',
  'Shoulder.R', 'UpperArm.R', 'LowerArm.R', 'Fist.R',
]);

const qInv = (q) => Quaternion.Inverse(q);
const angleBetween = (a, b) => {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
};

// index every TransformNode under a container's roots by name
function indexNodes(container) {
  const map = new Map();
  for (const root of container.rootNodes) {
    map.set(root.name, root);
    for (const n of root.getDescendants(false)) map.set(n.name, n);
  }
  return map;
}

// parents-first ordering so a node's parent world is current when we read it
function topDown(nodes) {
  const out = [];
  const seen = new Set();
  const visit = (n) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
    for (const c of n.getChildren?.() ?? []) visit(c);
  };
  for (const n of nodes) if (!n.parent || !nodes.includes(n.parent)) visit(n);
  // fallback: ensure every node present
  for (const n of nodes) if (!seen.has(n)) { seen.add(n); out.push(n); }
  return out;
}

function ensureQuat(n) {
  if (!n.rotationQuaternion) n.rotationQuaternion = n.rotation.toQuaternion();
  return n.rotationQuaternion;
}

// Read a group's animated LOCAL value for a node property at a given frame,
// interpolating between keys; returns null if the node isn't animated so the
// caller can fall back to the rest value.
function makeSampler(group) {
  const byKey = new Map(); // "name|prop" -> sorted keys
  for (const ta of group.targetedAnimations) {
    const keys = ta.animation.getKeys();
    byKey.set(ta.target.name + '|' + ta.animation.targetProperty, keys);
  }
  return (name, prop, frame) => {
    const keys = byKey.get(name + '|' + prop);
    if (!keys || keys.length === 0) return null;
    if (frame <= keys[0].frame) return keys[0].value.clone();
    const last = keys[keys.length - 1];
    if (frame >= last.frame) return last.value.clone();
    let i = 1;
    while (i < keys.length && keys[i].frame < frame) i++;
    const a = keys[i - 1], b = keys[i];
    const t = (frame - a.frame) / (b.frame - a.frame);
    return prop === 'position'
      ? Vector3.Lerp(a.value, b.value, t)
      : Quaternion.Slerp(a.value, b.value, t);
  };
}

function unionFrames(group) {
  const set = new Set();
  for (const ta of group.targetedAnimations)
    for (const k of ta.animation.getKeys()) set.add(k.frame);
  return [...set].sort((x, y) => x - y);
}

// Detect whether Babylon composes worldQ = localQ*parentQ ("child-first") or
// parentQ*localQ, by checking a bone whose parent is actually rotated at rest.
function detectChildFirst(nodes) {
  let childFirst = 0, votes = 0;
  for (const n of nodes) {
    const p = n.parent;
    if (!p || !p.absoluteRotationQuaternion || !n.rotationQuaternion) continue;
    const L = n.rotationQuaternion, P = p.absoluteRotationQuaternion, W = n.absoluteRotationQuaternion;
    if (angleBetween(P, Quaternion.Identity()) < 0.05) continue; // parent ~unrotated: uninformative
    const eChild = angleBetween(L.multiply(P), W); // worldQ = localQ * parentQ
    const eParent = angleBetween(P.multiply(L), W); // worldQ = parentQ * localQ
    if (Math.abs(eChild - eParent) < 1e-4) continue;
    childFirst += eChild < eParent ? 1 : -1;
    votes++;
  }
  return { childFirst: childFirst >= 0, votes };
}

// Build a { worldFromLocalParent, localFromWorldParent, deltaFromRest, applyDelta }
// algebra kit consistent with the detected composition order.
function makeAlgebra(childFirst) {
  if (childFirst) {
    // worldQ = localQ * parentQ
    return {
      localFromWorld: (world, parent) => world.multiply(qInv(parent)),
      // world delta d such that world = d * rest  ->  d = world * rest^-1
      deltaFromRest: (world, rest) => world.multiply(qInv(rest)),
      applyDelta: (delta, rest) => delta.multiply(rest),
    };
  }
  // worldQ = parentQ * localQ
  return {
    localFromWorld: (world, parent) => qInv(parent).multiply(world),
    deltaFromRest: (world, rest) => world.multiply(qInv(rest)),
    applyDelta: (delta, rest) => delta.multiply(rest),
  };
}

function computeWorlds(orderedNodes) {
  for (const n of orderedNodes) n.computeWorldMatrix(true);
}

/**
 * Bake retargeted Idle/Walk/PickUp AnimationGroups onto `target` (Mixamo) using
 * the clips already on `donor` (Quaternius). Groups are added to
 * target.animationGroups so instantiateModelsToScene clones them per shopper.
 * Idempotent-ish: caller should only invoke when target has no clips yet.
 */
export function retargetClips(donor, target, scene, { hipsBob = true } = {}) {
  const dNodes = indexNodes(donor);
  const tNodes = indexNodes(target);

  // resolve the mapped pairs that actually exist in both rigs
  const pairs = [];
  for (const [src, dst] of Object.entries(RETARGET_MAP)) {
    const s = dNodes.get(src), t = tNodes.get(dst);
    if (s && t) pairs.push({ src, dst, s, t });
  }
  if (!pairs.length) { console.warn('[retarget] no bone pairs matched'); return []; }

  const dOrder = topDown([...dNodes.values()]);
  const tOrder = topDown([...tNodes.values()]);
  dOrder.forEach(ensureQuat);
  tOrder.forEach(ensureQuat);

  // rest pose: capture rest local + rest world rotations
  computeWorlds(dOrder);
  computeWorlds(tOrder);
  const dRestLocal = new Map(dOrder.map((n) => [n, n.rotationQuaternion.clone()]));
  const dRestPos = new Map(dOrder.map((n) => [n, n.position.clone()]));
  const tRestLocal = new Map(tOrder.map((n) => [n, n.rotationQuaternion.clone()]));
  const tRestPos = new Map(tOrder.map((n) => [n, n.position.clone()]));
  const tRestWorld = new Map(tOrder.map((n) => [n, n.absoluteRotationQuaternion.clone()]));
  const dRestWorld = new Map(pairs.map((p) => [p.s, p.s.absoluteRotationQuaternion.clone()]));

  const detect = detectChildFirst(tOrder);
  const alg = makeAlgebra(detect.childFirst);
  console.log('[retarget] composition childFirst=', detect.childFirst, 'votes=', detect.votes);

  // hips vertical bob transfer scale (target units per source unit)
  const dHips = dNodes.get('Hips') || dNodes.get('Body');
  const tHips = tNodes.get('mixamorig_Hips');
  const hipRatio = dHips && tHips && Math.abs(dRestPos.get(dHips).y) > 1e-4
    ? tRestPos.get(tHips).length() / Math.max(1e-4, dRestPos.get(dHips).length())
    : 1;

  const madeGroups = [];
  const donorGroups = new Map(donor.animationGroups.map((g) => [g.name, g]));

  for (const clipName of CLIPS) {
    const group = donorGroups.get(clipName);
    if (!group) continue;
    const sample = makeSampler(group);
    const frames = unionFrames(group);
    const fps = group.targetedAnimations[0]?.animation.framePerSecond || 60;

    // per-target-node key arrays
    const rotKeys = new Map(pairs.map((p) => [p.t, []]));
    const hipKeys = [];

    for (const frame of frames) {
      // 1) pose the donor at this frame (animated locals; rest elsewhere)
      for (const n of dOrder) {
        const r = sample(n.name, 'rotationQuaternion', frame);
        n.rotationQuaternion.copyFrom(r || dRestLocal.get(n));
        const p = sample(n.name, 'position', frame);
        if (p) n.position.copyFrom(p); else n.position.copyFrom(dRestPos.get(n));
      }
      computeWorlds(dOrder);

      // 2) for each mapped target bone compute the retargeted local rotation,
      //    applying it live so children read the correct animated parent world
      for (const n of tOrder) n.rotationQuaternion.copyFrom(tRestLocal.get(n));
      for (const p of pairs) {
        const srcNow = p.s.absoluteRotationQuaternion;
        // arms: match the source's absolute orientation (bind poses differ);
        // everything else: delta from rest (bind poses agree, keeps proportions)
        const tgtWorld = ABSOLUTE_BONES.has(p.src)
          ? srcNow.clone()
          : alg.applyDelta(alg.deltaFromRest(srcNow, dRestWorld.get(p.s)), tRestWorld.get(p.t));
        p.t.computeWorldMatrix(true); // refresh parent chain
        const parentWorld = p.t.parent?.absoluteRotationQuaternion || Quaternion.Identity();
        const local = alg.localFromWorld(tgtWorld, parentWorld);
        p.t.rotationQuaternion.copyFrom(local);
        p.t.computeWorldMatrix(true);
        rotKeys.get(p.t).push({ frame, value: local.clone() });
      }

      // 3) hips vertical bob
      if (hipsBob && dHips && tHips) {
        const bob = (dHips.position.y - dRestPos.get(dHips).y) * hipRatio;
        const pos = tRestPos.get(tHips).clone();
        pos.y += bob;
        hipKeys.push({ frame, value: pos });
      }
    }

    // 4) assemble AnimationGroup
    const ag = new AnimationGroup(clipName, scene);
    for (const p of pairs) {
      const anim = new Animation(`${clipName}_${p.dst}_rot`, 'rotationQuaternion', fps,
        Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE);
      anim.setKeys(rotKeys.get(p.t));
      ag.addTargetedAnimation(anim, p.t);
    }
    if (hipsBob && tHips && hipKeys.length) {
      const anim = new Animation(`${clipName}_hips_pos`, 'position', fps,
        Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
      anim.setKeys(hipKeys);
      ag.addTargetedAnimation(anim, tHips);
    }
    ag.normalize(frames[0], frames[frames.length - 1]);
    target.animationGroups.push(ag);
    madeGroups.push(ag);
  }

  // restore both rigs to rest so the container is clean for instancing
  for (const n of dOrder) { n.rotationQuaternion.copyFrom(dRestLocal.get(n)); n.position.copyFrom(dRestPos.get(n)); }
  for (const n of tOrder) { n.rotationQuaternion.copyFrom(tRestLocal.get(n)); n.position.copyFrom(tRestPos.get(n)); }
  computeWorlds(dOrder);
  computeWorlds(tOrder);

  console.log('[retarget] baked', madeGroups.map((g) => g.name).join(', '), 'from', pairs.length, 'bones');
  return madeGroups;
}
