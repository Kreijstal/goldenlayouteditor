// Synthetic IDML package: two pages with red and blue rectangles; no third-party assets.
const JSZip = require('jszip');
const namespace = 'http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging';
async function createIdmlFixture() {
    const zip = new JSZip();
    zip.file('mimetype','application/vnd.adobe.indesign-idml-package',{compression:'STORE'});
    zip.file('designmap.xml',`<?xml version="1.0"?><Document xmlns:idPkg="${namespace}" DOMVersion="19.0" Self="document"><Layer Self="layer1" Name="Artwork" Visible="true"/><idPkg:Graphic src="Resources/Graphic.xml"/><idPkg:Styles src="Resources/Styles.xml"/><idPkg:Preferences src="Resources/Preferences.xml"/><idPkg:Fonts src="Resources/Fonts.xml"/><idPkg:Spread src="Spreads/Spread_one.xml"/><idPkg:Spread src="Spreads/Spread_two.xml"/></Document>`);
    zip.file('Resources/Graphic.xml',`<idPkg:Graphic xmlns:idPkg="${namespace}" DOMVersion="19.0"><Color Self="Color/Red" Model="Process" Space="RGB" ColorValue="255 0 0" Name="Red"/><Color Self="Color/Blue" Model="Process" Space="RGB" ColorValue="0 0 255" Name="Blue"/><Color Self="Color/Paper" Model="Process" Space="RGB" ColorValue="255 255 255" Name="Paper"/><Swatch Self="Swatch/None" Name="None"/></idPkg:Graphic>`);
    zip.file('Resources/Styles.xml',`<idPkg:Styles xmlns:idPkg="${namespace}" DOMVersion="19.0"><RootParagraphStyleGroup Self="paragraphs"/><RootCharacterStyleGroup Self="characters"/><RootObjectStyleGroup Self="objects"/></idPkg:Styles>`);
    zip.file('Resources/Fonts.xml',`<idPkg:Fonts xmlns:idPkg="${namespace}" DOMVersion="19.0"/>`);
    zip.file('Resources/Preferences.xml',`<idPkg:Preferences xmlns:idPkg="${namespace}" DOMVersion="19.0"><DocumentPreference PageHeight="144" PageWidth="144" FacingPages="false"/></idPkg:Preferences>`);
    for (const [index,name,color] of [[1,'one','Red'],[2,'two','Blue']]) {
        const points=[[20,20],[124,20],[124,124],[20,124]].map(([x,y])=>`<PathPointType Anchor="${x} ${y}" LeftDirection="${x} ${y}" RightDirection="${x} ${y}"/>`).join('');
        zip.file(`Spreads/Spread_${name}.xml`,`<idPkg:Spread xmlns:idPkg="${namespace}" DOMVersion="19.0"><Spread Self="spread_${name}" PageCount="1" BindingLocation="0" AllowPageShuffle="false"><Page Self="page_${name}" Name="${index}" GeometricBounds="0 0 144 144" ItemTransform="1 0 0 1 0 0"/><Rectangle Self="rectangle_${name}" ItemLayer="layer1" FillColor="Color/${color}" StrokeColor="Swatch/None" StrokeWeight="0" ItemTransform="1 0 0 1 0 0" GeometricBounds="20 20 124 124"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>${points}</PathPointArray></GeometryPathType></PathGeometry></Properties></Rectangle></Spread></idPkg:Spread>`);
    }
    return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
module.exports={createIdmlFixture};
