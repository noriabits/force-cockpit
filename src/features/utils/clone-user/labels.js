// Clone User — UI labels
// All user-facing strings for the Clone User feature.
// Loaded before view.js so window.CloneUserLabels is available when view.js runs.

window.CloneUserLabels = {
  // Buttons
  btnSearch: 'Search',
  btnChange: 'Change',
  btnCloneUser: 'Clone User',
  btnSelect: 'Select',

  // Step headings
  stepSourceUser: '1. Source User',
  stepNewUserDetails: '2. New User Details',

  // Form labels
  labelFirstName: 'First Name',
  labelLastName: 'Last Name',
  labelEmail: 'Email',
  labelGeneratedUsername: 'Generated Username',

  // Placeholders
  placeholderSearch: 'Search by name or email...',
  placeholderFirstName: 'e.g. Pablo',
  placeholderLastName: 'e.g. Fernandez Posadas',
  placeholderEmail: 'e.g. pablo.fernandez@company.com',
  placeholderUsername: '\u2014',

  // Descriptions
  descSourceUser:
    'Search for the user you want to clone from. Their profile, role, and permission sets will be copied to the new user.',
  descNewUserDetails:
    'Enter the details for the new user. The username will be auto-generated based on the org type (sandbox/production).',

  // Dynamic messages
  errorNotConnected: 'Not connected to any org.',
  errorNoUsersFound: 'No users found matching that search.',
  statusCloning: 'Cloning user\u2026',
};
