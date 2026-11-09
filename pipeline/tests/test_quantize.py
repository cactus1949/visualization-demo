import numpy as np
from ncpipe.quantize import quantize,dequantize

def test_roundtrip():
 x=np.linspace(-2,3,101); q,m=quantize(x,-2,3,8); y=dequantize(q,m['scale'],m['offset']); assert np.max(abs(x-y))<=m['scale']/2+1e-8
 q,m=quantize(x,-2,3,16); y=dequantize(q,m['scale'],m['offset']); assert np.max(abs(x-y))<=m['scale']/2+1e-8

def test_clip_nan():
 q,m=quantize(np.array([-2.,0.,2.,np.nan]),0,1,8); assert q[0]==0 and q[2]==255 and q[3]==0; assert m['nan_count']==1; assert m['clipped_low_frac']>0

def test_log10():
 x=np.array([100.,1000.,10000.]); q,m=quantize(x,2,4,8,'log10'); y=dequantize(q,m['scale'],m['offset'],'log10'); assert np.max(abs(np.log10(y)-np.log10(x)))<=m['scale']/2+1e-8
