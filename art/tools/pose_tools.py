# Posing helpers for keying clips in Blender, by where limbs go rather than by axis angles (an
# imported rig's bone axes need not follow its limbs, nor its armature's axes the world's).
# exec(open('<repo>/art/tools/pose_tools.py').read()) inside Blender, then:
#   pt = PoseTools(armature)
#   pt.two_bone('upperarm.l', 'lowerarm.l', 'hand.l', target, pole)  # elbow bends toward pole
#   pt.turn('spine', (1, 0, 0), 15)                                 # about a world axis
# Joints are where each bone's child starts (its head), so lengths are the limb's own.

import math
import bpy
from mathutils import Matrix, Vector


class PoseTools:
    def __init__(self, arm):
        self.arm, self.pbs, self.W = arm, arm.pose.bones, arm.matrix_world
        self.to_arm = self.W.to_3x3().inverted()

    def upd(self):
        bpy.context.view_layer.update()

    def at(self, bone):
        """A joint's world position (the bone's head)."""
        self.upd()
        return self.W @ self.pbs[bone].head

    def aim(self, bone, child, direction):
        """Turn `bone` about its head so its child's joint lies in world `direction`."""
        pb = self.pbs[bone]
        self.upd()
        cur = (self.at(child) - self.at(bone)).normalized()
        d = (self.to_arm @ Vector(direction)).normalized()
        cur_a = (self.to_arm @ cur).normalized()
        r = cur_a.rotation_difference(d).to_matrix().to_4x4()
        head = pb.matrix.translation.copy()
        m = pb.matrix.copy()
        m.translation = (0, 0, 0)
        m = r @ m
        m.translation = head
        pb.matrix = m
        self.upd()

    def turn(self, bone, world_axis, deg):
        pb = self.pbs[bone]
        self.upd()
        a = (self.to_arm @ Vector(world_axis)).normalized()
        m = pb.matrix.copy()
        t = m.translation.copy()
        m = Matrix.Rotation(math.radians(deg), 4, a) @ m
        m.translation = t
        pb.matrix = m
        self.upd()

    def two_bone(self, upper, lower, end, target, pole):
        """Bend a two-bone limb so its end joint reaches world `target` (or as near as it
        stretches), its middle joint bending toward world direction `pole`."""
        s, e, w = self.at(upper), self.at(lower), self.at(end)
        a, b = (e - s).length, (w - e).length
        t = Vector(target)
        d = max(1e-6, min((t - s).length, (a + b) * 0.999))
        u = (t - s).normalized()
        p = Vector(pole)
        n = (p - p.dot(u) * u)
        n = n.normalized() if n.length > 1e-6 else Vector((0, 0, 1))
        cos_a = max(-1.0, min(1.0, (a * a + d * d - b * b) / (2 * a * d)))
        elbow = s + a * (cos_a * u + math.sqrt(1 - cos_a * cos_a) * n)
        self.aim(upper, lower, elbow - s)
        self.aim(lower, end, (s + u * d) - self.at(lower))
        return (self.at(end) - t).length   # how far short of the target it ended (0 = reached)
