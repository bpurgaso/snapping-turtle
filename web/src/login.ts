import { auth } from './api.js';
import { mount } from './dom.js';
import { credentialsForm } from './forms.js';

const root = document.getElementById('app');
if (root) {
  mount(
    root,
    credentialsForm({
      heading: 'Sign in',
      submitLabel: 'Sign in',
      alternate: { text: 'Need an account?', href: '/signup', label: 'Sign up' },
      onSubmit: async (creds) => {
        await auth.login(creds);
        window.location.assign('/account');
      },
    }),
  );
}
