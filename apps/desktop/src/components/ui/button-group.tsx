import * as React from 'react';
import {cn} from '../../lib/utils.js';
export function ButtonGroup({className,...props}:React.ComponentProps<'div'>){
 return <div role="group" data-slot="button-group" className={cn('inline-flex items-stretch [&>*]:rounded-none [&>*:first-child]:rounded-l-md [&>*:last-child]:rounded-r-md [&>*+*]:-ml-px',className)} {...props}/>;
}
