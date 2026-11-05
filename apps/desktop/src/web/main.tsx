import React from 'react';
import {createRoot} from 'react-dom/client';
import {WebApp} from './WebApp.js';
import './web.css';
createRoot(document.getElementById('root')!).render(<WebApp/>);
