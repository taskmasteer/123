import {parse,generate} from 'css-tree';

// Captured desktop styles contain fixed side margins and padding. A one-column
// grid alone does not make them responsive: text can end up in a 20px column.
// Keep the desktop composition intact and override only captured mobile geometry.
export function referenceResponsiveCss(css){
 const left=[],right=[],large=[];
 const ast=parse(css);
 ast.children.forEach(rule=>{
  if(rule.type!=='Rule'||!rule.prelude)return;
  const selector=generate(rule.prelude);if(!/^\.ref-s\d+$/.test(selector))return;
  rule.block.children.forEach(decl=>{
   if(decl.type!=='Declaration')return;
   const value=generate(decl.value);
   if(decl.property==='padding'){
    const values=value.split(/\s+/);if(!values.every(v=>/^(?:0|\d+(?:\.\d+)?px)$/.test(v)))return;
    if(parseFloat(values[1]??values[0])>16)right.push(selector);
    if(parseFloat(values[3]??values[1]??values[0])>16)left.push(selector);
   }
   if(decl.property==='font-size'&&/^\d+(?:\.\d+)?px$/.test(value)&&parseFloat(value)>36)large.push(selector);
  });
 });
 const group=(selectors,style)=>selectors.length?[...new Set(selectors)].join(',')+'{'+style+'}':'';
 return '\n/* Responsive reference geometry: preserve this mobile baseline. */\n@media(max-width:700px){\n.ref-node{grid-template-columns:minmax(0,1fr)!important;flex-wrap:wrap!important;max-width:100%!important;min-width:0!important;margin-inline:0!important;min-height:0!important;overflow-wrap:anywhere}\n'+group(left,'padding-left:16px!important')+'\n'+group(right,'padding-right:16px!important')+'\n'+group(large,'font-size:36px!important;line-height:1.15!important')+'\n}\n';
}
