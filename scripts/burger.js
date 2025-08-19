// Reusable burger menu behavior for all pages
(function(){
  document.addEventListener('DOMContentLoaded', () => {
    const burgerMenu = document.getElementById('burger-menu');
    const burgerDropdownMenu = document.getElementById('burger-dropdown-menu');
    if (!burgerMenu || !burgerDropdownMenu) return;

    let open = false;
    const toggle = () => {
      open = !open;
      burgerDropdownMenu.classList.toggle('show', open);
    };
    const close = () => {
      open = false;
      burgerDropdownMenu.classList.remove('show');
    };

    burgerMenu.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

    // Hover state mirrors index behavior
    const items = burgerDropdownMenu.querySelectorAll('.burger-menu-item');
    items.forEach(it => {
      it.addEventListener('mouseenter', () => burgerMenu.classList.add('dropdown-hovered'));
      it.addEventListener('mouseleave', () => burgerMenu.classList.remove('dropdown-hovered'));
    });
    burgerDropdownMenu.addEventListener('mouseenter', () => burgerMenu.classList.add('dropdown-hovered'));
    burgerDropdownMenu.addEventListener('mouseleave', () => burgerMenu.classList.remove('dropdown-hovered'));

    document.addEventListener('click', (e) => {
      if (!burgerMenu.contains(e.target) && !burgerDropdownMenu.contains(e.target)) close();
    });
  });
})();
