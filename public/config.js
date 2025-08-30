// public/config.js
// Single source of truth for study-wide constants.
// Exposes CONFIG and CODE_REGEX on the window for non-module scripts.


window.CONFIG = {
  IMAGE_1: 'images/description1.jpg',
  IMAGE_2: 'images/description2.jpg',
  ASLCT_ACCESS_CODE: 'DVCWHNABJ',
  EEG_CALENDLY_URL: 'https://calendly.com/action-brain-lab-gallaudet/spatial-cognition-eeg-only',
  SUPPORT_EMAIL: 'action.brain.lab@gallaudet.edu'
};

window.CODE_REGEX = /^[A-Z0-9]{8}$/;
