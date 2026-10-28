# Pose checks for clips keyed in Blender, run inside Blender (the MCP's execute, or the Text
# Editor): exec(open('<repo>/art/tools/pose_check.py').read()), then call the functions below.
#
# They answer, for an armature and its meshes, frame by frame, what a picture can hide:
#   inside(...)   how many vertices of some parts (say the arms) are inside other parts (the head)
#   lowest(...)   how far the lowest point is off the ground
#   front(...)    how far forward any vertex of some parts reaches (against a wall line)
#
# A "part" is the set of vertices that mostly follow some bones (by name, matched by a test
# function), so it works whether a character is one mesh (the Chibi) or several (the Skeleton).

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree


def _dominant(obj, i):
    groups = obj.data.vertices[i].groups
    if not groups:
        return None
    g = max(groups, key=lambda g: g.weight)
    return obj.vertex_groups[g.group].name


def _evaluated(meshes):
    """Every mesh's evaluated (posed) vertex positions in world space."""
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    out = {}
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        out[o.name] = ([o.matrix_world @ v.co for v in me.vertices], [p.vertices[:] for p in me.polygons])
        ev.to_mesh_clear()
    return out


_RAYS = [Vector(d) for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1))]


def _crossings(tree, p, d, limit=64):
    n, at = 0, p.copy()
    for _ in range(limit):
        hit = tree.ray_cast(at, d)
        if hit[0] is None:
            break
        n += 1
        at = hit[0] + d * 1e-5
    return n


def inside(meshes, mover, solid):
    """How many vertices of the `mover` parts lie inside the `solid` parts, now.
    `mover` and `solid` take a bone name and say whether it belongs. A vertex is inside when most
    of five rays from it (sideways, front, back, up) cross the solid's surface an odd number of
    times: a surface left open (a head's neck hole) fools one ray, not most of them. (Checking
    the nearest surface's facing instead counted 95 vertices of the Chibi's idle arms inside its
    head, which they are not.)"""
    posed = _evaluated(meshes)
    pts_all, polys_all, owners = [], [], []
    for o in meshes:
        pts, polys = posed[o.name]
        base = len(pts_all)
        pts_all += pts
        owners += [_dominant(o, i) for i in range(len(pts))]
        polys_all += [tuple(base + j for j in p) for p in polys]
    solid_polys = [p for p in polys_all if all(owners[j] and solid(owners[j]) for j in p)]
    if not solid_polys:
        return 0
    tree = BVHTree.FromPolygons(pts_all, solid_polys)
    n = 0
    for i, p in enumerate(pts_all):
        if owners[i] and mover(owners[i]):
            odd = sum(_crossings(tree, p, d) % 2 for d in _RAYS)
            if odd >= 3:
                n += 1
    return n


def lowest(meshes):
    posed = _evaluated(meshes)
    return min(min(v.z for v in pts) for pts, _ in posed.values())


def front(meshes, part):
    """The most forward (lowest y: characters face -Y here) any vertex of `part` reaches."""
    posed = _evaluated(meshes)
    best = 1e9
    for o in meshes:
        pts, _ = posed[o.name]
        for i, p in enumerate(pts):
            b = _dominant(o, i)
            if b and part(b):
                best = min(best, p.y)
    return best


def over_frames(scene, frames, fn):
    """fn() at each frame, as a list."""
    out = []
    for f in frames:
        scene.frame_set(f)
        out.append(fn())
    return out
