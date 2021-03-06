describe('counter', () => {
  it('gets initial data and increments on click', () => {
    cy.visit('/');
    cy.get('.counter').contains('0');
    cy.get('.counterContainer input').click();
    cy.get('.counter').contains('1');
  });
});

describe('secret', () => {
  it('gets env var', () => {
    cy.visit('/');
    cy.get('.secret').should('have.text', 'shhhh');
  });
});

describe('app secret', () => {
  it('gets env var set from secrets API', () => {
    cy.visit('/');
    cy.get('.runningOn').should('exist').then(
      ($runningOn) => {
        if ($runningOn.text() === 'realm') cy.get('.appSecret').should('have.text', 'from CLI');
        else cy.get('.runningOn').should('have.text', 'uninitialized');
      }
    );
  });
});

describe('hack', () => {
  it('fails to access non exposed function', () => {
    cy.visit('/');
    cy.get('.notExposed .error').contains(/Cannot invoke index.hack - not an exposed function/);
  });

  it('fails to access module outside of root dir', () => {
    cy.visit('/');
    cy.get('.invalidFile .error').contains(/Cannot reference path outside of root dir: ..\/index/);
  });
});

describe('user HTTP handler', () => {
  it('gets from express handler', () => {
    cy.visit('/express');
    cy.get('.express').contains('hello from express');
    cy.get('.express-variables').contains('url:/variables originalUrl:/express/variables baseUrl:/express');
  });
});

describe('upload', () => {
  it('successfully uploads a file', () => {
    cy.visit('/');
    cy.fixture('reshuffle.png', 'base64').then((fileContent) => {
      cy.get('.upload input').upload(
        { fileContent, fileName: 'reshuffle.png', mimeType: 'image/png' },
        { subjectType: 'input' },
      );
      cy.get('.upload img')
        .should('be.visible')
        .and(($img) => {
          // "naturalWidth" and "naturalHeight" are set when the image loads
          expect($img[0].naturalWidth).to.be.greaterThan(0);
        });
    });
  });
});
