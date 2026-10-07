import bpy
import json

out = {"boxes": [], "ramp": None, "markers": {}}
for o in bpy.data.objects:
    if o.name.startswith("Col_"):
        d = dict(o)
        if d.get("collider") == "ramp":
            # convert Blender (x,y,z)->three (x,z,-y) for bound box corners
            xs, ys, zs = [], [], []
            for v in o.data.vertices:
                xs.append(v.co.x); ys.append(v.co.z); zs.append(-v.co.y)
            out["ramp"] = {"name": o.name, "min": [min(xs), min(ys), min(zs)],
                           "max": [max(xs), max(ys), max(zs)]}
        else:
            # centre convert, size axes swap y/z
            c = [o.location.x, o.location.z, -o.location.y]
            s = [abs(o.scale.x), abs(o.scale.z), abs(o.scale.y)]
            out["boxes"].append({"name": o.name,
                                 "min": [c[0]-s[0]/2, c[1]-s[1]/2, c[2]-s[2]/2],
                                 "max": [c[0]+s[0]/2, c[1]+s[1]/2, c[2]+s[2]/2],
                                 "group": d.get("group", "other")})
    elif o.name.startswith("Spawn_") or o.name.startswith("Objective_"):
        out["markers"][o.name] = [o.location.x, o.location.z, -o.location.y]
    elif o.name.startswith("Reinforced_") or o.name.startswith("Hatch_"):
        # self collider: world AABB converted
        import mathutils
        ws = [o.matrix_world @ v.co for v in o.data.vertices] if o.data and hasattr(o.data, "vertices") else [o.location]
        xs = [v[0] for v in ws]; ys = [v[2] for v in ws]; zs = [-v[1] for v in ws]
        out["boxes"].append({"name": o.name, "min": [min(xs), min(ys), min(zs)],
                             "max": [max(xs), max(ys), max(zs)], "group": "wall"})

with open(r"D:\AI\seige-lite\test\colliders.dump.json", "w") as f:
    json.dump(out, f)
print("DUMPED boxes:", len(out["boxes"]), "ramp:", out["ramp"] is not None, "markers:", len(out["markers"]))
