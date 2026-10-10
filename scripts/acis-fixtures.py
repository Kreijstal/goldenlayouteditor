import base64,json
from ezdxf.acis import api
from ezdxf.render import forms
mesh=forms.cube();mesh.translate(42,0,0);body=api.body_from_mesh(mesh)
sat='\n'.join(api.export_sat([body],version=700)).encode('ascii');sab=api.export_sab([body],version=21800)
assert len(api.load(sat.decode('ascii').splitlines()))==1
assert len(api.load(sab))==1
print(json.dumps({kind:base64.b64encode(data).decode('ascii') for kind,data in [('sat',sat),('sab',sab)]}))
