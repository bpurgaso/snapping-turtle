import { PASSWORD_MIN_LENGTH } from '@snapping-turtle/shared/constants';
import { auth } from './api.js';
import { mount } from './dom.js';
import { credentialsForm } from './forms.js';

const root = document.getElementById('app');
if (root) {
  mount(
    root,
    credentialsForm({
      heading: 'Create an account',
      submitLabel: 'Sign up',
      hint: `Usernames are lowercase letters, digits, "_", "." or "-". Passwords need at least ${PASSWORD_MIN_LENGTH} characters. Registration may be closed by the admin.`,
      alternate: { text: 'Already have an account?', href: '/login', label: 'Sign in' },
      onSubmit: async (creds) => {
        await auth.signup(creds);
        window.location.assign('/account');
      },
    }),
  );
}
